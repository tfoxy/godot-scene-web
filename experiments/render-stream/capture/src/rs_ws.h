// rs_ws: a minimal, dependency-free RFC 6455 WebSocket server on its own I/O
// thread (protocol/gate1-design.md D3, Q3, Q4 "Where the WebSocket server
// lives" / "Live transport placement"), plus plain HTTP/1.1 GET serving on
// the same loopback listener (protocol/gate2-design.md D6, Q4 "Live: server,
// store and pins", G2c1; protocol/render-stream-2.md "HTTP (live)").
//
// Transport only: it moves opaque binary messages out and small text
// messages in over the WebSocket path, and serves byte blobs by content hash
// over plain HTTP GET. It knows nothing about render-stream records, the
// mirror, payload formats or any protocol framing above RFC 6455 / RFC 7230
// -- that is G1c2's rs1_live layer and G2c2's rs_resource_store, built on
// top of this one.
//
// Routing: every accepted connection starts out unclassified. The first
// (and, for an HTTP connection, every subsequent) request line's target path
// decides the route: an exact match against ServerConfig::path is a
// WebSocket upgrade attempt; a prefix match against
// ServerConfig::resource_prefix is a resource GET; anything else is 404.
// Once a connection becomes a WebSocket (a successful 101), it never serves
// HTTP again; an HTTP connection may serve any number of further requests,
// sequentially (no pipelining), until it or the peer closes it.
//
// Threading: start() spawns one I/O thread that owns every socket and never
// touches anything outside this file. Every public method below may be
// called from the main thread and never blocks on the network; take_events()
// drains what the I/O thread observed since the last call. The I/O thread and
// the caller's thread communicate only through the Server's internal mutex
// and a self-pipe used to wake poll(2) -- never a callback, so encoding and
// mirror access stay entirely on the caller's thread (gate1-design.md Q3,
// "All encoding happens on the main thread"). ResourceSource::lookup() is
// the one exception: it is called directly from the I/O thread (never the
// caller's thread), so it must be thread-safe and must not block on
// anything slower than memory (gate2-design.md Q4).
//
// Protocol subset implemented (gate1-design.md G1c1 "Protocol subset"):
//   - Handshake: GET <path> HTTP/1.1 with Upgrade: websocket, a Connection
//     header containing the token "upgrade", Sec-WebSocket-Version: 13, a
//     Sec-WebSocket-Key, and a Sec-WebSocket-Protocol listing
//     one of ServerConfig::subprotocols (G7n). Headers over 8 KiB, a wrong path, a missing
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
//
// HTTP GET subset implemented (gate2-design.md G2c1, render-stream-2.md
// "HTTP (live)"):
//   - `GET <resource_prefix><hash> HTTP/1.1` where <hash> is exactly 64
//     lowercase hex characters. ResourceSource::lookup(hash) decides the
//     body: non-null -> 200 with Content-Type: application/octet-stream,
//     Content-Length, `Cache-Control: private, max-age=31536000, immutable`
//     and `ETag: "<hash>"`; null -> 404. `If-None-Match: "<hash>"` on a hash
//     the source holds gets 304 (same cache headers, no body) instead of
//     200. A malformed path under resource_prefix (wrong hash length or
//     case, non-hex) -> 400. A non-GET method under resource_prefix -> 405
//     with `Allow: GET`. Every response carries an explicit Content-Length
//     (0 for every bodyless response) so a client that does not special-case
//     204/304 framing (Godot's HTTPClientTCP among them) still frames the
//     next response on the same connection correctly.
//   - `source` may be null (no provider registered yet): every resource GET
//     then answers 404. The source is consulted on every GET; the server
//     does no caching of its own.
//   - Keep-alive is the default; a request with `Connection: close` (or a
//     request this server cannot safely keep parsing past, such as an
//     unreadable request line) closes the TCP connection after the response
//     is flushed. No pipelining: this server only starts parsing the next
//     request once the previous one's response has been fully framed (it
//     does not wait for the peer to have read it, which it cannot observe).
//   - max_http_clients bounds the number of TCP connections concurrently
//     classified as HTTP (independently of max_clients, which bounds only
//     WebSocket connections -- a resource fetch over HTTP must be able to
//     proceed while the one WebSocket slot is in use). Exceeding it ->
//     503, connection closed. A WebSocket connection never counts against
//     it, and vice versa.
//
// Bearer-token authorization (gate2-design.md D13, G2e): when
// ServerConfig::auth_token is non-empty, every WebSocket upgrade and every
// resource GET must carry `Authorization: Bearer <auth_token>` (RFC 6750).
// Missing or wrong -> 401 ("Unauthorized"), never a close code -- the TCP
// connection is simply not upgraded (WS) or the request is answered and the
// connection kept alive or closed exactly as any other error status (HTTP
// GET). The comparison against auth_token is constant-time
// (constant_time_equals, below), independent of where the strings first
// differ or whether their lengths match. auth_token empty (the default)
// disables the check entirely: every request is treated as authorized,
// exactly as before G2e.
//
// Two subprotocols, origin and CORS (gate7-design.md D2, D3, Q2, Q3; G7n):
//   - ServerConfig::subprotocols lists every subprotocol the upgrade accepts, most preferred
//     first; the upgrade chooses the first one of them the client offered (render-stream.7 over
//     render-stream.6 when both are), echoes it, and reports it on the Opened event. A client
//     offering none of them -> 400, as before.
//   - ServerConfig::hello_token_subprotocols: an upgrade that chose one of these skips the bearer
//     check above -- render-stream/7 carries its token in the hello (a browser WebSocket cannot
//     set an Authorization header), which the layer above checks. Every other subprotocol keeps
//     the G2e upgrade check. Resource GETs keep `Authorization: Bearer` whatever the subprotocol.
//   - Origin: a request with no `Origin` header is exactly as before G7n. A request whose
//     `Origin` is not one of ServerConfig::allowed_origins (exact string match; the list is empty
//     by default) gets 403 on the WebSocket path and on the resource route, whatever its method,
//     before any other check; it is reported as one OriginRejected event (never HttpGet, Opened
//     or AuthRejected). `enforce_origins = false` (the accept-any-origin sabotage) treats every
//     origin as allowed.
//   - CORS, for a resource-route request with an allowed `Origin`: every response adds
//     `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`; `OPTIONS` answers a 204
//     preflight (`Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: GET`,
//     `Access-Control-Allow-Headers: authorization`, `Access-Control-Max-Age: 7200`,
//     `Vary: Origin`, no Content-Length -- RFC 9110 8.6 forbids it on a 204) whether or not the
//     hash is servable or even well formed, with no bearer check (a browser sends no credentials
//     on a preflight); it is reported as an HttpGet event with method "OPTIONS" and status 204.
//     `OPTIONS` without `Origin` is still 405. `cors_headers = false` (the no-cors sabotage)
//     omits every Access-Control-* header and changes nothing else. A WebSocket upgrade from an
//     allowed origin is unchanged.
#ifndef GRC_RS_WS_H
#define GRC_RS_WS_H

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace grc {
namespace live {

struct ServerConfig {
  std::string host = "127.0.0.1";
  std::uint16_t port = 0;  // 0 = ephemeral; Server::port() reports the bound one.
  std::size_t max_clients = 1;
  std::size_t max_inbound_text = 4096;
  std::string path = "/render-stream";
  // Every accepted subprotocol, most preferred first (G7n; was one `subprotocol` before).
  std::vector<std::string> subprotocols = {"render-stream.1"};
  std::size_t max_queued_bytes = 64u << 20;  // safety net, closes 1008.
  std::string resource_prefix = "/resources/sha256/";
  std::size_t max_http_clients = 8;  // concurrent HTTP (non-WebSocket) connections.
  std::string auth_token;            // empty (default): no bearer-token check (G2e).
  // G7n: subprotocols whose upgrade skips the bearer check (the token travels in the hello).
  std::vector<std::string> hello_token_subprotocols;
  // G7n (gate7-design.md D3): exact `Origin` values allowed; a request with any other Origin gets
  // 403. Empty (default): every request carrying an Origin is refused; one without is unaffected.
  std::vector<std::string> allowed_origins;
  bool enforce_origins = true;  // false: accept-any-origin sabotage (the allowlist is ignored).
  bool cors_headers = true;     // false: no-cors sabotage (no Access-Control-* header at all).
};

// True iff `a` and `b` hold the same bytes, compared in time that depends only on
// max(a.size(), b.size()) -- never on where the two first differ or on whether their lengths
// match (gate2-design.md D13). Exposed for its own unit test and used by the bearer-token check
// on both the WebSocket upgrade and the resource GET.
bool constant_time_equals(std::string_view a, std::string_view b);

// G7n (gate7-design.md Q3): parses GRC_LIVE_ALLOWED_ORIGINS, a comma list (spaces around an entry
// are ignored; empty text is the empty list). Every entry must be exactly `scheme://host:port` as
// a browser serializes an Origin: a lowercase scheme ([a-z][a-z0-9+.-]*), a lowercase host
// ([a-z0-9.-]+, or a bracketed IPv6 literal of [0-9a-f:.]) and a decimal port 1..65535 without a
// leading zero -- no path, query, fragment, userinfo or trailing slash. Returns false with
// *error naming the first bad entry (and leaves *out empty) on anything else.
bool parse_allowed_origins(std::string_view text, std::vector<std::string> *out, std::string *error);

// What the server asks for the bytes behind a resource hash. Implemented by
// G2c2's rs_resource_store; rs_ws knows nothing about where the bytes come
// from or what they mean.
class ResourceSource {
 public:
  virtual ~ResourceSource() = default;

  // Called on the I/O thread for every resource GET whose hash is already
  // validated (exactly 64 lowercase hex characters). Must be thread-safe
  // (the caller's thread may be forming a snapshot concurrently) and must
  // never block on anything slower than memory -- the I/O thread serves
  // every other connection, WebSocket included, from the same poll() loop.
  // Returns the payload bytes, or null to answer 404.
  virtual std::shared_ptr<const std::vector<std::uint8_t>> lookup(std::string_view hash) = 0;
};

struct Event {
  // AuthRejected (G2e): a WebSocket upgrade request was refused for a missing or wrong bearer
  // token (401). It is pushed instead of Opened -- the connection never reaches Opened or Closed
  // (opened stays false, exactly as a rejected handshake for any other reason; conn is the id
  // that was about to open). A resource GET's own 401 is reported as an ordinary HttpGet event
  // with http_status 401, not this kind.
  // OriginRejected (G7n): a request whose Origin is not allowed was answered 403 (`origin`,
  // `method`, `route`; `hash` too on the resource route). Like AuthRejected it never reaches
  // Opened or Closed, and the resource route reports it instead of an HttpGet event.
  enum Kind { Opened, Text, Closed, HttpGet, AuthRejected, OriginRejected } kind;
  std::uint32_t conn = 0;
  std::string text;          // Kind::Text: the message. Kind::Closed: the reason, if any.
  std::uint16_t code = 0;    // Kind::Closed only.
  std::string reason;        // Kind::Closed only (duplicates text for readability at call sites).
  std::string hash;          // Kind::HttpGet only: the hash from the request path (as received;
                             // may be malformed -- that is part of what the 400/405 cases report).
  // Kind::HttpGet: the status sent (200, 204, 304, 400, 401, 404, 405, 503); OriginRejected: 403.
  std::uint16_t http_status = 0;
  std::uint64_t bytes = 0;        // Kind::HttpGet only: the response body size (0 unless 200).
  // G7n. Kind::Opened: the subprotocol the upgrade chose. Opened, HttpGet and OriginRejected: the
  // request's Origin header ("" when absent). HttpGet and OriginRejected: the request method
  // ("GET", "OPTIONS", ...). OriginRejected: the route, "upgrade" or "resource".
  std::string subprotocol;
  std::string origin;
  std::string method;
  std::string route;
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

  // Binds and starts the I/O thread. `source` answers resource GETs (D6);
  // it may be null, in which case every resource GET answers 404. `source`
  // is never owned by the Server and must outlive it. Returns false and
  // sets *error without starting anything if host is not a loopback literal
  // ("non-loopback"), the bind/listen fails (errno text), or start() was
  // already called.
  bool start(const ServerConfig &config, ResourceSource *source, std::string *error);

  // The actually-bound port (meaningful once start() returned true); useful
  // when ServerConfig::port was 0.
  std::uint16_t port() const;

  // Drains and returns every event observed since the last call, in the
  // order the I/O thread observed them. Events for one connection are never
  // reordered: Opened precedes every Text for that connection, and Closed is
  // always last. An HTTP (non-WebSocket) connection produces one HttpGet
  // event per request and never an Opened or Closed event -- Closed is
  // reserved for a connection that reached Opened. A WebSocket upgrade
  // refused for a bad bearer token (G2e) produces one AuthRejected event and
  // never an Opened or Closed event either. A request refused for its Origin
  // (G7n, 403) produces one OriginRejected event and nothing else.
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
