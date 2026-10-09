// rs_ws: a minimal, dependency-free RFC 6455 WebSocket server on its own I/O
// thread (protocol/gate1-design.md D3, Q3, Q4 "Where the WebSocket server
// lives" / "Live transport placement").
//
// Transport only: it moves opaque binary messages out and small text
// messages in. It knows nothing about render-stream records, the mirror or
// any protocol framing above RFC 6455 -- that is G1c2's rs1_live layer,
// built on top of this one.
//
// Threading: start() spawns one I/O thread that owns every socket and never
// touches anything outside this file. Every public method below may be
// called from the main thread and never blocks on the network; take_events()
// drains what the I/O thread observed since the last call. The I/O thread and
// the caller's thread communicate only through the Server's internal mutex
// and a self-pipe used to wake poll(2) -- never a callback, so encoding and
// mirror access stay entirely on the caller's thread (gate1-design.md Q3,
// "All encoding happens on the main thread").
//
// Protocol subset implemented (gate1-design.md G1c1 "Protocol subset"):
//   - Handshake: GET <path> HTTP/1.1 with Upgrade: websocket, a Connection
//     header containing the token "upgrade", Sec-WebSocket-Version: 13, a
//     Sec-WebSocket-Key, and a Sec-WebSocket-Protocol listing
//     ServerConfig::subprotocol. Headers over 8 KiB, a wrong path, a missing
//     subprotocol, a client beyond max_clients, or anything else malformed
//     is answered with 404/400/503 and the TCP connection is closed; none of
//     that reaches take_events().
//   - Outbound frames (server -> client) are unfragmented and unmasked,
//     binary or text, with the 7/16/64-bit RFC 6455 length encoding.
//   - Inbound frames (client -> server) must be masked (else close 1002);
//     only unfragmented text frames carry application data (binary -> 1003,
//     fragmentation -> 1002); text above max_inbound_text -> 1009; a ping is
//     answered with a pong carrying the same payload (no Event); a pong is
//     ignored; a close is echoed and the connection shuts down.
//   - max_queued_bytes is a safety net against an unresponsive peer: an
//     enqueue that would exceed it is refused and the connection is closed
//     with 1008. Real traffic under credit-based delivery (gate1-design.md
//     Q4) never approaches it; a sabotage that ignores credit (G1d) is
//     expected to.
//   - Bind is loopback-only: ServerConfig::host must be exactly "127.0.0.1"
//     or "::1"; start() refuses (error "non-loopback") for anything else.
#ifndef GRC_RS_WS_H
#define GRC_RS_WS_H

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace grc {
namespace live {

struct ServerConfig {
  std::string host = "127.0.0.1";
  std::uint16_t port = 0;  // 0 = ephemeral; Server::port() reports the bound one.
  std::size_t max_clients = 1;
  std::size_t max_inbound_text = 4096;
  std::string path = "/render-stream";
  std::string subprotocol = "render-stream.1";
  std::size_t max_queued_bytes = 64u << 20;  // safety net, closes 1008.
};

struct Event {
  enum Kind { Opened, Text, Closed } kind;
  std::uint32_t conn = 0;
  std::string text;          // Kind::Text: the message. Kind::Closed: the reason, if any.
  std::uint16_t code = 0;    // Kind::Closed only.
  std::string reason;        // Kind::Closed only (duplicates text for readability at call sites).
  // steady_clock nanoseconds when the I/O thread observed the event (set by the server; G1c2
  // measures credit round trips from it, independently of when the main thread drains events).
  std::uint64_t t_ns = 0;
};

class Server {
 public:
  Server();
  ~Server();
  Server(const Server &) = delete;
  Server &operator=(const Server &) = delete;

  // Binds and starts the I/O thread. Returns false and sets *error without
  // starting anything if host is not a loopback literal ("non-loopback"),
  // the bind/listen fails (errno text), or start() was already called.
  bool start(const ServerConfig &config, std::string *error);

  // The actually-bound port (meaningful once start() returned true); useful
  // when ServerConfig::port was 0.
  std::uint16_t port() const;

  // Drains and returns every event observed since the last call, in the
  // order the I/O thread observed them. Events for one connection are never
  // reordered: Opened precedes every Text for that connection, and Closed is
  // always last.
  std::vector<Event> take_events();

  // Queues one complete message for conn. Returns false, enqueuing nothing,
  // if conn is not open or the enqueue would push that connection's queued
  // bytes over ServerConfig::max_queued_bytes -- in the latter case the
  // connection is also closed with 1008. Never blocks.
  bool send_binary(std::uint32_t conn, std::vector<std::uint8_t> message);
  bool send_text(std::uint32_t conn, std::string message);

  // Queues a close frame (best effort) and marks conn for shutdown; the I/O
  // thread closes the TCP connection once the frame is flushed or on the
  // next pass if the peer is unresponsive. A no-op if conn is not open.
  void close(std::uint32_t conn, std::uint16_t code, std::string reason);

  struct ConnStats {
    std::uint64_t queued_bytes = 0;      // currently unflushed.
    std::uint64_t max_queued_bytes = 0;  // high-water mark for this connection.
    std::uint64_t sent_bytes = 0;
    std::uint64_t sent_messages = 0;
    std::uint64_t received_text = 0;
  };
  // All-zero if conn is unknown (never opened, or already closed and forgotten).
  ConnStats stats(std::uint32_t conn) const;

  // Sends close(1000) to every open connection, gives flush_timeout_ms for
  // queued bytes to drain and close handshakes to complete, then force-closes
  // whatever remains and joins the I/O thread. Safe to call at most once;
  // a no-op if start() never succeeded.
  void stop(int flush_timeout_ms);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace live
}  // namespace grc

#endif  // GRC_RS_WS_H
