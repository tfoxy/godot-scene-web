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
// distinct hash it has ever sent, for its whole life. Since P3-SP every connection's set lives in
// one host-wide CarriedIndex (rs_carried.h: one compact entry per hash, a bit per connection).
//
// render-stream/11 (W11b, render-stream-11.md "Resource retention: the carried set"): a /11
// connection keeps no carried set. Its records before a target T are inline(T) \ inline(B), B the
// last snapshot it sent (rs2_diff.h records_before: property L2), a function of (B, T) alone, so
// connections in lockstep share the record list and its encodes like the transaction itself. The
// host-wide CarriedIndex serves /6-/10 connections only. Dynamic mesh surfaces travel inside the
// transaction (`mesh_u8`) and take no record.
//
// Shared publication (P3-SP, results/p3/p3-sp.md): the published snapshot is held once
// (shared_ptr) by every connection whose base or pending target it is, never copied per
// connection. Within one frame callback, connections that send the same transaction (the same
// base snapshot, the same target, the same version) share its diff and encode: the first one forms
// it, the others re-stamp only the meta's leading seq/frame/encoding/base_seq, so every connection
// still gets exactly the bytes it would get alone. Inline resource records are encoded once per
// hash per callback, and each target's payload hashes are looked up once.
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
//
// Formation (HC5, host-cost-design.md D4 "Moving work off the main thread"): the frame callback
// decides everything that is frame-paired (which connections send, the target, the base, seq and
// frame, credit, the window, rate ticks, pins, the below-/11 carried marks) and queues one job per
// sending connection. A job forms what that decision implies -- the /11 record plan, the resource
// records, the transaction (make_full / make_patch, encode_transaction, or a re-stamp of a
// lockstep connection's bytes), the live coding (zstd) -- and hands every message to the
// transport in the hub's order: the session message (a connection's first), its resource records,
// then its transaction. The jobs of one callback run in submission order, so the P3-SP memo is
// the job runner's: a second lockstep connection's job finds the first one's bytes. Published
// states are immutable (HC4a/HC4b), so a job reads its base and target without a lock; it touches
// no hub state but the memo and its connection's FormState (the coding prefix and, W13b, the
// /13 predictor), and reports what it did (counters, live-log lines, a too-large
// error) in the job itself. The frame callback's thread completes the jobs (`sync()`, at every
// later entry point: the next event, frame, finish, GET or summary), applying the counters and
// writing the live log in the order a synchronous hub would have written it. LiveConfig::
// formation chooses where jobs run: Inline (at the end of the frame callback, on its thread: the
// tests' default) or Thread (one encode thread: entry.cpp's default, GRC_HC_FORMATION=inline
// selects Inline). The wire is byte-identical either way; only when the bytes leave differs.
#ifndef GRC_RS_LIVE_H
#define GRC_RS_LIVE_H

#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "rs13_predict.h"
#include "rs2_snapshot.h"
#include "rs_captured.h"
#include "rs_carried.h"
#include "rs_histogram.h"
#include "rs_item_meta.h"
#include "rs_live_coding.h"

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
  // hello, /9 only (render-stream-9.md "Hello"): comma lists matching ^[a-z0-9]+(,[a-z0-9]+)*$,
  // at most 96 chars (texture-delivery-design.md Q3). Parsing only -- no Hub behaviour reads them
  // until a delivery increment does.
  std::string texture_encodings;
  std::string gpu_formats;
  // hello, /11 only, optional (W11t, render-stream-11.md "As built (W11t)"): the live codings the
  // receiver decodes, in its preference order (^[a-z0-9-]+(,[a-z0-9-]+)*$, <= 96 chars). Absent:
  // none, so the connection stays uncoded.
  bool has_live_coding = false;
  std::string live_coding;
  // hello, /13 only, optional (TAG1, client-extensions-design.md §2.1): the identity the viewer
  // asks for. Absent: not asked (the hello is byte for byte a no-extension client's).
  bool has_item_meta = false;
  rs::item_meta::Request item_meta;
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
// At ProtocolVersion::V7 (and V8, whose live transport is /7's) the hello has nine more keys (render-stream-7.md "Hello", gate7-design.md
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
// The subprotocol that makes a connection /8 (render-stream-8.md "Live transport", gate8-design.md
// D2): /7's live transport with /8's session and tables. Opt-in; no receiver offers it by default.
inline constexpr const char *kSubprotocolV8 = "render-stream.8";
// The subprotocol that makes a connection /9 (render-stream-9.md "Live transport",
// texture-delivery-design.md D4): /8's live transport with /9's hello keys `texture_encodings` and
// `gpu_formats`. Opt-in (GRC_STREAM_VERSION=9); no receiver offers it yet.
inline constexpr const char *kSubprotocolV9 = "render-stream.9";
// The subprotocol that makes a connection /10 (render-stream-10.md "Live transport"): /9's live
// transport and hello with /10's session and items. Opt-in (GRC_STREAM_VERSION=10).
inline constexpr const char *kSubprotocolV10 = "render-stream.10";
// The subprotocol that makes a connection /11 (render-stream-11.md "Live transport"): /10's live
// transport and hello under render-stream/11, with /11's carried-set rules, dynamic mesh surfaces
// and stable content_version. Opt-in (GRC_STREAM_VERSION=11).
inline constexpr const char *kSubprotocolV11 = "render-stream.11";
// PM5 (render-stream-12.md): /11's live transport under render-stream/12.
inline constexpr const char *kSubprotocolV12 = "render-stream.12";
// W13b (render-stream-13.md "As built (W13b)"): /12's live transport under render-stream/13, the
// predicted blocks coded per connection (FormState's rs13::Predictor). Opt-in
// (GRC_STREAM_VERSION=13).
inline constexpr const char *kSubprotocolV13 = "render-stream.13";

// HC5: where a frame callback's formation jobs run (rs_live.h header, "Formation").
enum class Formation : std::uint8_t { Inline, Thread };

// The formation a default-constructed LiveConfig gets (Inline unless set). The test binaries set
// Thread to run every hub test through the encode thread (with formation_wait).
Formation default_formation();
bool default_formation_wait();
void set_default_formation(Formation formation, bool wait);

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
  // W11b (render-stream-11.md "Sabotage kinds"): `keep-carried` -- a /11 connection keeps /10's
  // lifelong carried set (rs2_diff.h RecordPlanner), so a hash that returns is never re-carried.
  bool keep_carried = false;
  // PM1 (render-stream-11.md "As built (PM1)" rule 11): `perturb-instance` -- from this frame on,
  // a /11 connection's encoder adds 1.0 to the first multimesh buffer float it writes (0: off).
  std::uint64_t perturb_instance_frame = 0;
  std::uint64_t perturb_seed_frame = 0;  // PM5: sabotage perturb-seed's frame (0: off)
  std::uint64_t window_overrun_frame = 0;  // G7q (a listener sabotage, rs_live.h header)
  // W11t (render-stream-11.md "As built (W11t)"): GRC_LIVE_CODING, the coding a /11 connection
  // gets when its hello offers it (rs_live_coding.h negotiate). Off by default here so that a
  // Hub built without it (the tests that predate W11t) never codes; entry.cpp sets zstd-base.
  rs::live_coding::Coding live_coding = rs::live_coding::Coding::Off;
  // W11t listener sabotage coding-wrong-prefix: from this frame on, the first based transaction
  // whose frame decodes differently against its true base is coded against that base plus one
  // byte, under the true base_seq (0 disables).
  std::uint64_t coding_wrong_prefix_frame = 0;
  // W13b listener sabotage predict-stale (render-stream-13.md "Sabotages"): from this frame on,
  // the first /13 patch is predicted from H2 as if it were H1 (rs13::Predictor::predict_stale),
  // once per host (0 disables). The receiver fails predict-check and resyncs (reason coding).
  std::uint64_t predict_stale_frame = 0;
  // TAG1 (client-extensions-design.md §2.1): GRC_ITEM_META, the operator's grant (item_meta::k*
  // bits; 0: nobody gets identities, whatever a hello asks). `item_meta_sabotage` is
  // GRC_ITEM_META_SABOTAGE's formation half: in-shared, skip-full or id-off-by-one.
  std::uint32_t item_meta_grant = 0;
  std::string item_meta_sabotage;
  // G7n: GRC_LIVE_CREDIT_WINDOW_MAX (1..2, default 2); every grant is also capped at
  // kHostCreditWindow.
  std::uint64_t credit_window_max = 2;
  // G7n: the session's bearer token (GRC_LIVE_AUTH=token), checked against a /7 hello's `token`;
  // empty: no session auth, a /7 hello's token is not checked (`token_ok` null).
  std::string auth_token;
  bool token_ignored = false;  // G7n sabotage token-ignored: a wrong /7 token is not refused.
  // HC5: the formation jobs' thread. `formation_wait` (tests) makes each frame callback wait for
  // its own jobs and complete them before it returns, so a test reads the transport at once.
  Formation formation = default_formation();
  bool formation_wait = default_formation_wait();
  // HC5 sabotage `reorder` (GRC_HC_SABOTAGE=reorder, a test knob, never on the wire): from this
  // frame on, a job sends its transaction before its resource records (0: off).
  std::uint64_t reorder_frame = 0;
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
  std::string texture_encodings;  // /9 hello; empty otherwise
  std::string gpu_formats;
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
  // P3-SP: transactions this connection sent re-stamped from another connection's encode of the
  // same transaction in the same frame callback (0 for a lone connection).
  std::uint64_t shared_sends = 0;
  // W11t (/11 connections; the summary's `live_coding` object): the hello's offer, the coding
  // the host chose, the coded messages (and how many had a base prefix or came from another
  // connection's encode of the same (base, target) messages in the callback), their uncoded and
  // wire bytes, and the encode time. `wrong_prefix_seq` is the coding-wrong-prefix sabotage's seq.
  bool has_live_coding = false;
  std::string live_coding_offer;
  std::string live_coding = "off";
  std::uint64_t coded_messages = 0;
  std::uint64_t coded_prefixed = 0;
  std::uint64_t coded_shared = 0;
  std::uint64_t coded_input_bytes = 0;
  std::uint64_t coded_wire_bytes = 0;
  std::uint64_t coding_ns = 0;
  std::uint64_t wrong_prefix_seq = 0;
  // W13b (/13 connections; the summary's `predict` object): transactions whose /13 coding this
  // connection formed itself, those it re-stamped from a lockstep connection's coding in the
  // same callback (equal predictor history, equal /12 transaction), the /12 and /13 message bytes
  // of its transactions, the coding time, and the predict-stale sabotage's seq.
  std::uint64_t predict_formed = 0;
  std::uint64_t predict_shared = 0;
  std::uint64_t predict_plain_bytes = 0;
  std::uint64_t predict_bytes = 0;
  std::uint64_t predict_ns = 0;
  std::uint64_t predict_stale_seq = 0;
  // W13f: the connection's predictor history storage (rs13::ReuseStats): states refilled in place
  // and states allocated, over the transactions it formed itself.
  std::uint64_t predict_states_reused = 0;
  std::uint64_t predict_states_made = 0;
  // TAG1 (/13 connections whose hello asked; the summary's `item_meta` object): the request, the
  // grant (empty: refused), the records sent (full, delta), their bytes and rows, the records a
  // lockstep connection's formation gave it, and the deltas skipped as empty.
  bool has_item_meta = false;
  rs::item_meta::Request item_meta_request;
  rs::item_meta::Request item_meta_grant;
  std::uint64_t item_meta_full = 0;
  std::uint64_t item_meta_delta = 0;
  std::uint64_t item_meta_bytes = 0;
  std::uint64_t item_meta_rows = 0;
  std::uint64_t item_meta_shared = 0;
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
  // G8kz: the bytes that crossed the wire for the same 200s, the coding the host offered
  // ("off", "zstd" or "gzip"), GETs per coding, and the ServedResources coded-body totals.
  std::uint64_t http_coded_bytes = 0;
  std::string http_encoding = "off";
  std::uint64_t http_gets_zstd = 0;
  std::uint64_t http_gets_gzip = 0;
  std::uint64_t coded_made = 0;
  std::uint64_t coded_in_bytes = 0;
  std::uint64_t coded_out_bytes = 0;
  std::uint64_t coded_ns = 0;
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

  // HC5: waits for every formation job queued so far and completes them (their counters, live-log
  // lines and errors), in submission order. Every entry point that reads or writes connection
  // state calls it first; entry.cpp also calls it at the top of each frame callback.
  void sync();

  // True when on_frame needs a snapshot at callback `frame`/`now_ns`: a connection holds a
  // received hello, or is streaming with credit and (under rate control, G6r) a tick due at
  // `now_ns` (or, under the G1d sabotages, would send without credit or keep a stale copy).
  // `now_ns` is unused when every connection is uncapped (GRC_PUBLISH_FPS=uncapped, the default).
  bool wants_snapshot(std::uint64_t frame, std::uint64_t now_ns) const;

  // HC1: true while a connection has sent its hello or is streaming -- somebody who reads the
  // stream. A connection still awaiting its hello is not a viewer (it names no resource yet).
  bool has_viewer() const;

  // HC3 (host-cost-design.md D2): true while an open connection speaks a version below /11, whose
  // mesh tables name every surface by its SHA-256 (a /11 host then hashes its dynamic surfaces
  // too). Counted from the connection's open, before its hello, so the snapshot of its first
  // transaction already has them.
  bool has_connection_below_v11() const;

  // TAG1 (client-extensions-design.md §2.2): the union of what the open, granted connections ask
  // (empty: nobody, so the capture resolves nothing), and a counter that moves whenever it may
  // have changed, so the frame callback's check is one compare.
  std::uint64_t item_meta_version() const { return item_meta_version_; }
  rs::item_meta::Request item_meta_union() const;
  // The frame's identities, handed to the formation side with the callback's first job.
  void item_meta_batch(std::shared_ptr<const rs::item_meta::Batch> batch) {
    meta_batches_.push_back(std::move(batch));
  }

  // One frame callback. `snapshot` is the published state for `frame` (required when
  // wants_snapshot() was true; may be null otherwise); `epoch` the mirror's mutation epoch read
  // before it was copied; `snapshot_ns` its copy time (added to each sending stream's stats).
  void on_frame(std::uint64_t frame, std::uint64_t now_ns, const rs::Captured *snapshot,
                std::uint64_t epoch, std::uint64_t snapshot_ns);
  // P3-SP: the same, with the published snapshot shared rather than copied (the capture's path:
  // the hub keeps it as every sending connection's base without a per-connection copy).
  void on_frame_shared(std::uint64_t frame, std::uint64_t now_ns,
                       std::shared_ptr<const rs::Captured> snapshot, std::uint64_t epoch,
                       std::uint64_t snapshot_ns);

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
  void release_closed(Conn &c);
  // P3-SP: every open tap and live log, flushed at the end of each frame callback and of finish().
  void flush_taps();
  // `message` is the uncoded message (what the tap holds); on a coded connection (W11t) `wire` is
  // what is sent instead.
  bool deliver(Conn &c, const std::vector<std::uint8_t> &message, bool send,
               const std::vector<std::uint8_t> *wire = nullptr);
  // W11t: a coded connection's wire bytes for a non-transaction message (memoized by `memo_key`
  // when not empty: a /11 record's hash) and for a transaction (memoized per callback by its
  // uncoded base and target messages and their seqs). Null when the coder failed.
  // HC5: `coded_shared` and `coding_ns` are the caller's counters (a job's, or a connection's).
  std::shared_ptr<const std::vector<std::uint8_t>> coded_plain(
      std::uint64_t *coded_shared, std::uint64_t *coding_ns,
      const std::vector<std::uint8_t> &message, const std::string &memo_key);
  // Decides the next transaction (or, under drop-message, a tapped-only one) and queues its
  // formation in this callback's job for the connection (HC5); the connection's state advances
  // at once. The live log's `sent` object is written when the job completes.
  // `stale_from` (stale-coalesce) is the frame the snapshot was taken at, 0 otherwise.
  // `capture_ns` (G6r Q3c "Staleness") is the frame callback's time the snapshot was captured at
  // -- `now_ns` for a fresh send, or the earlier time it was set aside for a stale-coalesce send.
  void send_transaction(Conn &c, const std::shared_ptr<const rs::Captured> &snapshot,
                        std::uint64_t frame, std::uint64_t now_ns, std::uint64_t epoch,
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

  // P3-SP: one frame callback's shared work. HC5: the formation memo is the job runner's.
  struct FormState;  // HC5: a connection's state on the formation side (the coding prefix)
  struct Job;        // HC5: one connection's formation for one frame callback
  struct Memo;       // HC5: the formation memo of one frame callback (P3-SP, W11b, W11t)
  struct Counters;   // HC5: what a job adds to its connection's summary and end stats
  class Former;      // HC5: the encode thread
  Job &batch_job(Conn &c);
  void submit_batch();
  void run_job(Job &job);
  void complete(Job &job);
  bool form_deliver(Job &job, const std::vector<std::uint8_t> &message, bool send,
                    const std::vector<std::uint8_t> *wire);
  std::shared_ptr<const std::vector<std::uint8_t>> form_coded_tx(
      Job &job, const std::shared_ptr<const std::vector<std::uint8_t>> &message);
  // W13b: the /13 message of `plain` (the /12 transaction) on the job's connection: re-stamped
  // from a lockstep connection's coding in this callback, or coded by its predictor. W13p:
  // `predict` is the transaction's typed meta keys (rs13::predict_meta()), so the predictor does
  // not re-read the meta JSON (nullptr: it does).
  std::shared_ptr<const std::vector<std::uint8_t>> form_predicted(
      Job &job, const std::shared_ptr<const std::vector<std::uint8_t>> &plain,
      const rs13::PredictMeta *predict);
  struct TargetRefs;  // a target's payload refs and their CarriedIndex ids
  struct SharedTx;    // an encoded transaction other connections may re-stamp
  struct V11Records;  // W11b: the /11 records before a target, for one (base, target) pair
  struct CodedTx;     // W11t: a coded transaction, for one (base, target) message pair
  struct PredictedTx;  // W13b: a /13 transaction, for one /12 transaction and predictor history
  const TargetRefs &target_refs(const std::shared_ptr<const rs::Captured> &target);
  // PM5: `lower` (a /11 connection of a /12 host) plans on the /11 view of both states.
  const V11Records &v11_records(const std::shared_ptr<const rs::Captured> &base,
                                const std::shared_ptr<const rs::Captured> &target,
                                bool lower = false);

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
  CarriedIndex carried_;     // P3-SP: every connection's carried hashes
  std::vector<std::unique_ptr<TargetRefs>> frame_targets_;  // the callback's (below /11, main)
  // HC5: the formation side. `memo_` (Memo: P3-SP's shared transactions and below-/11 record
  // encodes, W11b's record plans and /11 record encodes, W11t's coded messages) and
  // `wrong_prefix_done_` belong to whichever thread runs the jobs; `batch_` is the jobs this
  // frame callback is building; `former_` is the encode thread (Formation::Thread only).
  std::unique_ptr<Memo> memo_;
  bool wrong_prefix_done_ = false;
  bool predict_stale_done_ = false;  // W13b: predict-stale acted (once per host)
  // TAG1: the job's item_meta record (null when a delta would be empty), and its coded bytes.
  void form_item_meta(Job &job, bool full, std::shared_ptr<const std::vector<std::uint8_t>> *record,
                      std::shared_ptr<const std::vector<std::uint8_t>> *wire);
  // TAG1: the main thread's union counter and the batches not yet handed to a job; the formation
  // side's identity store and per-grant string tables (the job runner's).
  std::uint64_t item_meta_version_ = 0;
  std::vector<std::shared_ptr<const rs::item_meta::Batch>> meta_batches_;
  rs::item_meta::Store meta_store_;
  std::map<std::string, std::unique_ptr<rs::item_meta::GrantTable>> meta_tables_;
  std::vector<std::unique_ptr<Job>> batch_;
  std::unique_ptr<Former> former_;
};

}  // namespace rs2
}  // namespace grc

#endif  // GRC_RS_LIVE_H
