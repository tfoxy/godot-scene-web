#include "rs_ws.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <map>
#include <mutex>
#include <thread>
#include <utility>

#include "rs_sha1.h"

namespace grc {
namespace live {

namespace {

// ---------------------------------------------------------------------------
// Small string/byte helpers (no engine, no third-party code).
// ---------------------------------------------------------------------------

std::string to_lower(std::string s) {
  for (char &ch : s) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  return s;
}

std::string trim(const std::string &s) {
  const std::size_t begin = s.find_first_not_of(" \t");
  if (begin == std::string::npos) return "";
  const std::size_t end = s.find_last_not_of(" \t");
  return s.substr(begin, end - begin + 1);
}

// True if `value` (an RFC 7230 comma-separated header value) contains
// `token_lower`, compared case-insensitively, after trimming each piece.
bool token_list_contains(const std::string &value, const std::string &token_lower) {
  std::size_t start = 0;
  while (start <= value.size()) {
    const std::size_t comma = value.find(',', start);
    const std::string piece =
        trim(value.substr(start, comma == std::string::npos ? std::string::npos : comma - start));
    if (to_lower(piece) == token_lower) return true;
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return false;
}

// Lowercase hex digit, or -1.
int hex_value(char ch) {
  if (ch >= '0' && ch <= '9') return ch - '0';
  if (ch >= 'a' && ch <= 'f') return 10 + (ch - 'a');
  return -1;
}

// Exactly 64 lowercase hex characters (render-stream-2.md "Texture payload": a SHA-256 hex digest).
bool is_sha256_hex(const std::string &s) {
  if (s.size() != 64) return false;
  for (char ch : s) {
    if (hex_value(ch) < 0) return false;
  }
  return true;
}

// Strips one leading and one trailing '"' if both are present (ETag / If-None-Match are quoted
// per RFC 7232; a client may also send an unquoted value, which this passes through unchanged so
// it simply fails the hash comparison rather than being rejected outright).
std::string unquote(const std::string &s) {
  if (s.size() >= 2 && s.front() == '"' && s.back() == '"') return s.substr(1, s.size() - 2);
  return s;
}

std::string base64_encode(const std::uint8_t *data, std::size_t len) {
  static const char kTable[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  std::size_t i = 0;
  for (; i + 3 <= len; i += 3) {
    const std::uint32_t n = (static_cast<std::uint32_t>(data[i]) << 16) |
                             (static_cast<std::uint32_t>(data[i + 1]) << 8) |
                             static_cast<std::uint32_t>(data[i + 2]);
    out.push_back(kTable[(n >> 18) & 0x3F]);
    out.push_back(kTable[(n >> 12) & 0x3F]);
    out.push_back(kTable[(n >> 6) & 0x3F]);
    out.push_back(kTable[n & 0x3F]);
  }
  const std::size_t rem = len - i;
  if (rem == 1) {
    const std::uint32_t n = static_cast<std::uint32_t>(data[i]) << 16;
    out.push_back(kTable[(n >> 18) & 0x3F]);
    out.push_back(kTable[(n >> 12) & 0x3F]);
    out.push_back('=');
    out.push_back('=');
  } else if (rem == 2) {
    const std::uint32_t n =
        (static_cast<std::uint32_t>(data[i]) << 16) | (static_cast<std::uint32_t>(data[i + 1]) << 8);
    out.push_back(kTable[(n >> 18) & 0x3F]);
    out.push_back(kTable[(n >> 12) & 0x3F]);
    out.push_back(kTable[(n >> 6) & 0x3F]);
    out.push_back('=');
  }
  return out;
}

// RFC 6455 ssec 1.3.
std::string compute_accept_key(const std::string &client_key) {
  static const char kGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const auto digest = grc::sha1(client_key + kGuid);
  return base64_encode(digest.data(), digest.size());
}

// ---------------------------------------------------------------------------
// Outbound framing: the server only ever sends unfragmented, unmasked frames.
// ---------------------------------------------------------------------------

std::vector<std::uint8_t> encode_frame(std::uint8_t opcode, const std::uint8_t *payload, std::size_t len) {
  std::vector<std::uint8_t> out;
  out.reserve(len + 10);
  out.push_back(static_cast<std::uint8_t>(0x80 | (opcode & 0x0F)));  // FIN=1, RSV=0.
  if (len < 126) {
    out.push_back(static_cast<std::uint8_t>(len));
  } else if (len <= 0xFFFF) {
    out.push_back(126);
    out.push_back(static_cast<std::uint8_t>((len >> 8) & 0xFF));
    out.push_back(static_cast<std::uint8_t>(len & 0xFF));
  } else {
    out.push_back(127);
    for (int i = 7; i >= 0; --i) {
      out.push_back(static_cast<std::uint8_t>((static_cast<std::uint64_t>(len) >> (8 * i)) & 0xFF));
    }
  }
  out.insert(out.end(), payload, payload + len);
  return out;
}

std::vector<std::uint8_t> encode_frame(std::uint8_t opcode, const std::vector<std::uint8_t> &payload) {
  return encode_frame(opcode, payload.data(), payload.size());
}

// ---------------------------------------------------------------------------
// Inbound framing: the server only ever accepts masked, unfragmented frames.
// ---------------------------------------------------------------------------

enum class ParseStatus { Incomplete, Ok, ProtocolError };

struct FrameHeader {
  bool fin = false;
  std::uint8_t opcode = 0;
  std::uint64_t payload_len = 0;
  std::uint8_t mask[4] = {0, 0, 0, 0};
};

ParseStatus parse_frame_header(const std::vector<std::uint8_t> &buf, FrameHeader *out, std::size_t *consumed) {
  if (buf.size() < 2) return ParseStatus::Incomplete;
  const std::uint8_t b0 = buf[0];
  const std::uint8_t b1 = buf[1];
  const bool fin = (b0 & 0x80) != 0;
  const std::uint8_t rsv = b0 & 0x70;
  const std::uint8_t opcode = b0 & 0x0F;
  if (rsv != 0) return ParseStatus::ProtocolError;  // no extensions negotiated.
  const bool masked = (b1 & 0x80) != 0;
  if (!masked) return ParseStatus::ProtocolError;  // inbound frames must be masked.
  const std::uint8_t len7 = b1 & 0x7F;
  const bool is_control = opcode == 0x8 || opcode == 0x9 || opcode == 0xA;

  std::size_t pos = 2;
  std::uint64_t len = len7;
  if (len7 == 126) {
    if (is_control) return ParseStatus::ProtocolError;  // control frames can't use extended length.
    if (buf.size() < pos + 2) return ParseStatus::Incomplete;
    len = (static_cast<std::uint64_t>(buf[pos]) << 8) | buf[pos + 1];
    pos += 2;
  } else if (len7 == 127) {
    if (is_control) return ParseStatus::ProtocolError;
    if (buf.size() < pos + 8) return ParseStatus::Incomplete;
    len = 0;
    for (int i = 0; i < 8; ++i) len = (len << 8) | buf[pos + i];
    pos += 8;
    if (len & (static_cast<std::uint64_t>(1) << 63)) return ParseStatus::ProtocolError;  // MSB must be 0.
  }

  if (buf.size() < pos + 4) return ParseStatus::Incomplete;
  for (int i = 0; i < 4; ++i) out->mask[i] = buf[pos + i];
  pos += 4;

  out->fin = fin;
  out->opcode = opcode;
  out->payload_len = len;
  *consumed = pos;
  return ParseStatus::Ok;
}

// ---------------------------------------------------------------------------
// HTTP/1.1 upgrade request parsing.
// ---------------------------------------------------------------------------

// A generic HTTP/1.1 request head: the request line plus headers, with no opinion yet on where
// it routes. `parsed` is false only when the request line itself is unreadable (not even
// "TOKEN SP TOKEN SP TOKEN"); an unrecognized method or an unsupported version still parses, so
// the dispatcher can answer the right status (405 vs 400) instead of a blanket one.
struct ParsedRequest {
  bool parsed = false;
  std::string method;
  std::string path;
  bool version_ok = false;  // exactly "HTTP/1.1"
  std::map<std::string, std::string> headers;  // lowercased keys; repeats comma-joined, in order.
};

ParsedRequest parse_request_head(const std::string &head) {
  ParsedRequest req;
  const std::size_t line_end = head.find("\r\n");
  const std::string request_line = (line_end == std::string::npos) ? head : head.substr(0, line_end);
  const std::size_t sp1 = request_line.find(' ');
  if (sp1 == std::string::npos) return req;
  const std::size_t sp2 = request_line.find(' ', sp1 + 1);
  if (sp2 == std::string::npos) return req;
  req.parsed = true;
  req.method = request_line.substr(0, sp1);
  req.path = request_line.substr(sp1 + 1, sp2 - sp1 - 1);
  req.version_ok = request_line.substr(sp2 + 1) == "HTTP/1.1";

  std::size_t pos = (line_end == std::string::npos) ? head.size() : line_end + 2;
  while (pos < head.size()) {
    const std::size_t next = head.find("\r\n", pos);
    const std::string line = (next == std::string::npos) ? head.substr(pos) : head.substr(pos, next - pos);
    if (!line.empty()) {
      const std::size_t colon = line.find(':');
      if (colon != std::string::npos) {
        const std::string k = to_lower(trim(line.substr(0, colon)));
        const std::string v = trim(line.substr(colon + 1));
        auto it = req.headers.find(k);
        if (it != req.headers.end()) {
          it->second += ", " + v;
        } else {
          req.headers.emplace(k, v);
        }
      }
    }
    if (next == std::string::npos) break;
    pos = next + 2;
  }
  return req;
}

// Looks up a header by its (already lowercase) name; "" if absent.
std::string header_value(const ParsedRequest &req, const std::string &name_lower) {
  const auto it = req.headers.find(name_lower);
  return it == req.headers.end() ? std::string() : it->second;
}

bool request_wants_close(const ParsedRequest &req) {
  return token_list_contains(header_value(req, "connection"), "close");
}

// WebSocket-upgrade-specific header checks, folded out of parse_request_head so a plain HTTP GET
// never pays for them.
struct UpgradeHeaders {
  bool has_upgrade_websocket = false;
  bool has_connection_upgrade = false;
  bool version13 = false;
  std::string key;
  bool protocol_ok = false;
};

UpgradeHeaders check_upgrade_headers(const ParsedRequest &req, const std::string &expected_subprotocol) {
  UpgradeHeaders out;
  out.has_upgrade_websocket = token_list_contains(header_value(req, "upgrade"), "websocket");
  out.has_connection_upgrade = token_list_contains(header_value(req, "connection"), "upgrade");
  out.version13 = trim(header_value(req, "sec-websocket-version")) == "13";
  out.key = trim(header_value(req, "sec-websocket-key"));
  out.protocol_ok =
      token_list_contains(header_value(req, "sec-websocket-protocol"), to_lower(expected_subprotocol));
  return out;
}

void set_nonblocking(int fd) {
  const int flags = ::fcntl(fd, F_GETFL, 0);
  ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

const char *http_status_text(int status) {
  switch (status) {
    case 304:
      return "Not Modified";
    case 400:
      return "Bad Request";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}

std::vector<std::uint8_t> to_bytes(const std::string &s) {
  return std::vector<std::uint8_t>(s.begin(), s.end());
}

// Named Event constructors, one per Kind, each setting only the fields that Kind documents
// (rs_ws.h). Event now has more fields than any one Kind uses, so positional aggregate
// initialization at each call site would either miss some (-Wmissing-field-initializers) or
// force every call site to spell out fields it does not care about; these centralize that once.
Event make_opened_event(std::uint32_t conn) {
  Event e;
  e.kind = Event::Opened;
  e.conn = conn;
  return e;
}

Event make_text_event(std::uint32_t conn, std::string text) {
  Event e;
  e.kind = Event::Text;
  e.conn = conn;
  e.text = std::move(text);
  return e;
}

Event make_closed_event(std::uint32_t conn, std::uint16_t code, std::string reason) {
  Event e;
  e.kind = Event::Closed;
  e.conn = conn;
  e.text = reason;  // duplicated into text for readability at call sites, as before.
  e.code = code;
  e.reason = std::move(reason);
  return e;
}

Event make_http_get_event(std::uint32_t conn, std::string hash, std::uint16_t status, std::uint64_t bytes) {
  Event e;
  e.kind = Event::HttpGet;
  e.conn = conn;
  e.hash = std::move(hash);
  e.http_status = status;
  e.bytes = bytes;
  return e;
}

}  // namespace

// ---------------------------------------------------------------------------
// Connection state (I/O thread only, guarded by Impl::mu).
// ---------------------------------------------------------------------------

struct Conn {
  int fd = -1;
  std::uint32_t id = 0;
  // Handshaking also means "awaiting the next HTTP request line": an HTTP connection (unlike a
  // WebSocket one) never leaves this phase, since every request on it is parsed the same way.
  enum class Phase { Handshaking, Open, Closed } phase = Phase::Handshaking;
  std::vector<std::uint8_t> recv_buf;
  std::vector<std::uint8_t> send_buf;
  std::size_t send_off = 0;
  bool opened = false;              // an Opened event was pushed for this connection (WebSocket only).
  bool http_slot_held = false;      // this connection counts against max_http_clients.
  bool shutdown_after_flush = false;
  std::uint16_t pending_close_code = 1000;
  std::string pending_close_reason;
  std::uint64_t max_queued_bytes_seen = 0;
  std::uint64_t sent_bytes = 0;
  std::uint64_t sent_messages = 0;
  std::uint64_t received_text = 0;
};

struct Server::Impl {
  ServerConfig config;
  ResourceSource *resource_source = nullptr;  // never owned; may be null (every GET -> 404).
  int listen_fd = -1;
  int wake_r = -1;
  int wake_w = -1;
  std::uint16_t bound_port = 0;
  std::thread io_thread;
  std::atomic<bool> running{false};
  std::atomic<bool> stop_requested{false};
  int flush_timeout_ms = 0;

  std::mutex mu;
  std::map<std::uint32_t, Conn> conns;
  std::uint32_t next_id = 1;
  std::vector<Event> events;

  void wake() {
    if (wake_w < 0) return;
    const char b = 0;
    // Best effort: a full pipe means poll() is already about to wake anyway.
    if (::write(wake_w, &b, 1) < 0) { /* ignored */
    }
  }

  // --- Every method below assumes `mu` is already held by the caller. ---

  void push_event_locked(Event e) {
    e.t_ns = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                            std::chrono::steady_clock::now().time_since_epoch())
                                            .count());
    events.push_back(std::move(e));
  }

  // Enqueues raw (already-framed) bytes for conn. `bypass_limit` is for
  // frames the protocol itself requires (pong, close) -- never refused by
  // the queued-bytes safety net.
  bool enqueue_raw(Conn &c, std::vector<std::uint8_t> bytes, bool bypass_limit) {
    const std::uint64_t current = c.send_buf.size() - c.send_off;
    const std::uint64_t add = bytes.size();
    if (!bypass_limit && current + add > config.max_queued_bytes) return false;
    c.send_buf.insert(c.send_buf.end(), bytes.begin(), bytes.end());
    c.max_queued_bytes_seen = std::max(c.max_queued_bytes_seen, current + add);
    return true;
  }

  // Starts a graceful close: best-effort close frame, then marks the
  // connection for teardown once the frame (and anything queued ahead of it)
  // has flushed. Idempotent.
  void begin_close(Conn &c, std::uint16_t code, std::string reason) {
    if (c.phase == Conn::Phase::Closed || c.shutdown_after_flush) return;
    std::vector<std::uint8_t> payload;
    payload.push_back(static_cast<std::uint8_t>((code >> 8) & 0xFF));
    payload.push_back(static_cast<std::uint8_t>(code & 0xFF));
    payload.insert(payload.end(), reason.begin(), reason.end());
    enqueue_raw(c, encode_frame(0x8, payload), /*bypass_limit=*/true);
    c.shutdown_after_flush = true;
    c.pending_close_code = code;
    c.pending_close_reason = std::move(reason);
  }

  // Tears the socket down right now: no attempt to flush or send a frame.
  // Idempotent.
  void finalize_now(Conn &c, std::uint16_t code, const std::string &reason) {
    if (c.phase == Conn::Phase::Closed) return;
    ::shutdown(c.fd, SHUT_RDWR);
    ::close(c.fd);
    if (c.opened) push_event_locked(make_closed_event(c.id, code, reason));
    c.phase = Conn::Phase::Closed;
  }

  // If a graceful close has fully flushed, finalize it. Called after every
  // read/write pass for a connection.
  void maybe_finalize(Conn &c) {
    if (!c.shutdown_after_flush) return;
    if (c.send_off < c.send_buf.size()) return;
    finalize_now(c, c.pending_close_code, c.pending_close_reason);
  }

  void try_flush(Conn &c) {
    while (c.send_off < c.send_buf.size()) {
      const ssize_t n = ::send(c.fd, c.send_buf.data() + c.send_off, c.send_buf.size() - c.send_off, MSG_NOSIGNAL);
      if (n > 0) {
        c.send_off += static_cast<std::size_t>(n);
        c.sent_bytes += static_cast<std::uint64_t>(n);
        continue;
      }
      if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
      finalize_now(c, 1006, "send error");
      return;
    }
    if (c.send_off > 0) {
      if (c.send_off == c.send_buf.size()) {
        c.send_buf.clear();
        c.send_off = 0;
      } else if (c.send_off > (1u << 16)) {
        c.send_buf.erase(c.send_buf.begin(), c.send_buf.begin() + static_cast<std::ptrdiff_t>(c.send_off));
        c.send_off = 0;
      }
    }
  }

  // Closes the TCP connection (no WS close frame: used for both a rejected WS handshake and any
  // HTTP error that this server does not keep serving) once `resp` has flushed. `opened` stays
  // false on every path that reaches this, so finalize_now() pushes no Closed event.
  void reject(Conn &c, int status, const std::string &detail) {
    (void)detail;
    std::string resp = "HTTP/1.1 " + std::to_string(status) + " " + http_status_text(status) +
                        "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
    c.send_buf.insert(c.send_buf.end(), resp.begin(), resp.end());
    c.shutdown_after_flush = true;
    c.pending_close_code = 0;  // unused: opened stays false, so no Closed event is pushed.
  }

  // Counts other open WebSocket connections (against ServerConfig::max_clients).
  std::size_t count_ws_open(const Conn &exclude) const {
    std::size_t n = 0;
    for (const auto &entry : conns) {
      if (entry.second.id != exclude.id && entry.second.phase == Conn::Phase::Open) ++n;
    }
    return n;
  }

  // Counts other connections already holding an HTTP slot (against max_http_clients).
  std::size_t count_http_slots(const Conn &exclude) const {
    std::size_t n = 0;
    for (const auto &entry : conns) {
      if (entry.second.id != exclude.id && entry.second.http_slot_held) ++n;
    }
    return n;
  }

  // Sends one HTTP response on `c` that is not a 101 upgrade. `body` is empty for every status
  // this server ever answers with one (200 carries a body via the overload below; every other
  // status -- 304, 400, 404, 405, 503 -- has an empty body, Content-Length: 0 included, so a
  // client that does not special-case bodyless statuses still frames the next response on a
  // kept-alive connection correctly). Closes after flushing unless `keep_alive`.
  void send_http_status(Conn &c, int status, const std::vector<std::pair<std::string, std::string>> &headers,
                         bool keep_alive) {
    std::string resp = "HTTP/1.1 " + std::to_string(status) + " " + http_status_text(status) + "\r\n";
    for (const auto &h : headers) resp += h.first + ": " + h.second + "\r\n";
    resp += "Content-Length: 0\r\n";
    resp += keep_alive ? "Connection: keep-alive\r\n" : "Connection: close\r\n";
    resp += "\r\n";
    enqueue_raw(c, to_bytes(resp), /*bypass_limit=*/true);
    if (!keep_alive) {
      c.shutdown_after_flush = true;
      c.pending_close_code = 0;  // opened stays false on the HTTP route: no Closed event.
    }
  }

  // 200 OK with a body (render-stream-2.md "HTTP (live)").
  void send_http_ok(Conn &c, const std::string &hash, const std::vector<std::uint8_t> &body, bool keep_alive) {
    std::string resp = "HTTP/1.1 200 OK\r\n";
    resp += "Content-Type: application/octet-stream\r\n";
    resp += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    resp += "Cache-Control: private, max-age=31536000, immutable\r\n";
    resp += "ETag: \"" + hash + "\"\r\n";
    resp += keep_alive ? "Connection: keep-alive\r\n" : "Connection: close\r\n";
    resp += "\r\n";
    std::vector<std::uint8_t> out = to_bytes(resp);
    out.insert(out.end(), body.begin(), body.end());
    enqueue_raw(c, std::move(out), /*bypass_limit=*/true);
    if (!keep_alive) {
      c.shutdown_after_flush = true;
      c.pending_close_code = 0;
    }
  }

  // 304 Not Modified: the same cache headers as 200, no body (render-stream-2.md).
  void send_http_not_modified(Conn &c, const std::string &hash, bool keep_alive) {
    send_http_status(c, 304,
                      {{"Cache-Control", "private, max-age=31536000, immutable"}, {"ETag", "\"" + hash + "\""}},
                      keep_alive);
  }

  // Handles one resource GET (gate2-design.md D6, Q4; render-stream-2.md "HTTP (live)"). The
  // path has already been confirmed to start with config.resource_prefix.
  void dispatch_resource_get(Conn &c, const ParsedRequest &req) {
    const bool keep_alive = !request_wants_close(req);
    // Extracted before the method check so even a non-GET request's HttpGet event (below) names
    // the hash it attempted -- useful evidence (Q3's hook log) for a misbehaving client.
    const std::string hash = req.path.substr(config.resource_prefix.size());

    if (req.method != "GET") {
      send_http_status(c, 405, {{"Allow", "GET"}}, /*keep_alive=*/false);
      push_event_locked(make_http_get_event(c.id, hash, 405, 0));
      return;
    }
    if (!is_sha256_hex(hash)) {
      send_http_status(c, 400, {}, /*keep_alive=*/false);
      push_event_locked(make_http_get_event(c.id, hash, 400, 0));
      return;
    }
    if (!c.http_slot_held) {
      if (count_http_slots(c) >= config.max_http_clients) {
        send_http_status(c, 503, {}, /*keep_alive=*/false);
        push_event_locked(make_http_get_event(c.id, hash, 503, 0));
        return;
      }
      c.http_slot_held = true;
    }

    const std::shared_ptr<const std::vector<std::uint8_t>> payload =
        resource_source != nullptr ? resource_source->lookup(hash) : nullptr;
    if (payload == nullptr) {
      send_http_status(c, 404, {}, keep_alive);
      push_event_locked(make_http_get_event(c.id, hash, 404, 0));
      return;
    }
    const std::string if_none_match = unquote(trim(header_value(req, "if-none-match")));
    if (if_none_match == hash) {
      send_http_not_modified(c, hash, keep_alive);
      push_event_locked(make_http_get_event(c.id, hash, 304, 0));
      return;
    }
    send_http_ok(c, hash, *payload, keep_alive);
    push_event_locked(make_http_get_event(c.id, hash, 200, payload->size()));
  }

  void dispatch_ws_upgrade(Conn &c, const ParsedRequest &req) {
    if (req.method != "GET") {
      reject(c, 400, "expected GET");
      return;
    }
    const UpgradeHeaders up = check_upgrade_headers(req, config.subprotocol);
    if (!up.has_upgrade_websocket || !up.has_connection_upgrade || !up.version13 || up.key.empty()) {
      reject(c, 400, "malformed upgrade request");
      return;
    }
    if (!up.protocol_ok) {
      reject(c, 400, "missing subprotocol");
      return;
    }
    if (count_ws_open(c) >= config.max_clients) {
      reject(c, 503, "max_clients");
      return;
    }

    const std::string accept_key = compute_accept_key(up.key);
    const std::string resp = "HTTP/1.1 101 Switching Protocols\r\n"
                              "Upgrade: websocket\r\n"
                              "Connection: Upgrade\r\n"
                              "Sec-WebSocket-Accept: " +
                              accept_key + "\r\n" + "Sec-WebSocket-Protocol: " + config.subprotocol + "\r\n\r\n";
    c.send_buf.insert(c.send_buf.end(), resp.begin(), resp.end());
    c.phase = Conn::Phase::Open;
    c.opened = true;
    push_event_locked(make_opened_event(c.id));
    if (!c.recv_buf.empty()) process_frames(c);
  }

  // Parses and routes one request head. A connection stays in Phase::Handshaking across any
  // number of HTTP requests (handle_readable() calls this again for each); a WebSocket upgrade
  // leaves it via dispatch_ws_upgrade(), after which this is never called again for `c`.
  void try_request(Conn &c) {
    static const std::string kTerminator = "\r\n\r\n";
    const auto pos = std::search(c.recv_buf.begin(), c.recv_buf.end(), kTerminator.begin(), kTerminator.end());
    if (pos == c.recv_buf.end()) {
      if (c.recv_buf.size() > 8192) reject(c, 400, "headers too large");
      return;
    }
    const std::size_t head_len = static_cast<std::size_t>(pos - c.recv_buf.begin());
    const std::string head(c.recv_buf.begin(), c.recv_buf.begin() + static_cast<std::ptrdiff_t>(head_len));
    const std::size_t consumed = head_len + kTerminator.size();
    std::vector<std::uint8_t> leftover(c.recv_buf.begin() + static_cast<std::ptrdiff_t>(consumed), c.recv_buf.end());
    c.recv_buf = std::move(leftover);

    const ParsedRequest req = parse_request_head(head);
    if (!req.parsed || !req.version_ok) {
      reject(c, 400, "malformed request line");
      return;
    }

    if (req.path == config.path) {
      dispatch_ws_upgrade(c, req);
    } else if (req.path.rfind(config.resource_prefix, 0) == 0) {
      dispatch_resource_get(c, req);
    } else {
      reject(c, 404, "unknown path");
      return;
    }

    // Non-pipelined, but a test client (or a real one racing ahead of this server's response) may
    // still have put the next request's bytes in the same read. Keep parsing while this
    // connection stays an HTTP one (never Open: a WebSocket upgrade already returned above) and
    // isn't closing.
    if (!c.shutdown_after_flush && c.phase == Conn::Phase::Handshaking && !c.recv_buf.empty()) {
      try_request(c);
    }
  }

  void process_frames(Conn &c) {
    for (;;) {
      if (c.shutdown_after_flush) return;
      FrameHeader hdr;
      std::size_t consumed = 0;
      const ParseStatus st = parse_frame_header(c.recv_buf, &hdr, &consumed);
      if (st == ParseStatus::Incomplete) return;
      if (st == ParseStatus::ProtocolError) {
        begin_close(c, 1002, "protocol error");
        return;
      }
      if (hdr.opcode == 0x2) {  // binary inbound is not accepted (Q2 "Protocol subset").
        begin_close(c, 1003, "binary not accepted");
        return;
      }
      if (hdr.opcode == 0x1 && hdr.payload_len > config.max_inbound_text) {
        begin_close(c, 1009, "message too big");
        return;
      }
      if (!hdr.fin) {
        begin_close(c, 1002, "fragmentation not supported");
        return;
      }
      if (hdr.opcode != 0x1 && hdr.opcode != 0x8 && hdr.opcode != 0x9 && hdr.opcode != 0xA) {
        begin_close(c, 1002, "unsupported opcode");
        return;
      }
      const std::size_t total = consumed + hdr.payload_len;
      if (c.recv_buf.size() < total) return;  // wait for the rest of the payload.

      std::vector<std::uint8_t> payload(c.recv_buf.begin() + static_cast<std::ptrdiff_t>(consumed),
                                         c.recv_buf.begin() + static_cast<std::ptrdiff_t>(total));
      for (std::size_t i = 0; i < payload.size(); ++i) payload[i] ^= hdr.mask[i % 4];
      c.recv_buf.erase(c.recv_buf.begin(), c.recv_buf.begin() + static_cast<std::ptrdiff_t>(total));

      switch (hdr.opcode) {
        case 0x1: {
          c.received_text++;
          push_event_locked(make_text_event(c.id, std::string(payload.begin(), payload.end())));
          break;
        }
        case 0x9: {
          enqueue_raw(c, encode_frame(0xA, payload), /*bypass_limit=*/true);
          break;
        }
        case 0xA: {
          break;  // pong ignored.
        }
        case 0x8: {
          std::uint16_t code = 1000;
          std::string reason;
          if (payload.size() >= 2) {
            code = static_cast<std::uint16_t>((static_cast<std::uint16_t>(payload[0]) << 8) | payload[1]);
            reason.assign(payload.begin() + 2, payload.end());
          }
          begin_close(c, code, reason);
          return;
        }
        default:
          break;
      }
    }
  }

  void handle_readable(Conn &c) {
    if (c.shutdown_after_flush) return;
    std::uint8_t buf[65536];
    const ssize_t n = ::recv(c.fd, buf, sizeof(buf), 0);
    if (n == 0) {
      finalize_now(c, 1006, "peer closed");
      return;
    }
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      finalize_now(c, 1006, "recv error");
      return;
    }
    c.recv_buf.insert(c.recv_buf.end(), buf, buf + n);
    if (c.phase == Conn::Phase::Handshaking) {
      try_request(c);
    } else if (c.phase == Conn::Phase::Open) {
      process_frames(c);
    }
  }

  // Accepts every pending connection without classifying it: a new socket might become a
  // WebSocket upgrade or a resource GET, and max_clients / max_http_clients are independent
  // limits on those two roles (Q4 "coexisting with a live WebSocket on the same port"), so
  // neither can be enforced before the first request's path is known. try_request() enforces
  // both once it is.
  void accept_loop() {
    for (;;) {
      sockaddr_storage addr{};
      socklen_t alen = sizeof(addr);
      const int fd = ::accept(listen_fd, reinterpret_cast<sockaddr *>(&addr), &alen);
      if (fd < 0) break;  // EAGAIN/EWOULDBLOCK or a transient error: stop accepting this pass.
      set_nonblocking(fd);
      const int one = 1;
      ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

      Conn c;
      c.fd = fd;
      c.id = next_id++;
      conns.emplace(c.id, std::move(c));
    }
  }

  void io_loop() {
    bool deadline_set = false;
    std::chrono::steady_clock::time_point deadline{};
    std::uint8_t drain[256];

    for (;;) {
      const bool stopping = stop_requested.load();
      if (stopping && !deadline_set) {
        deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(flush_timeout_ms);
        deadline_set = true;
      }
      {
        std::lock_guard<std::mutex> lock(mu);
        if (stopping && conns.empty()) break;
      }
      if (stopping && std::chrono::steady_clock::now() >= deadline) {
        std::lock_guard<std::mutex> lock(mu);
        for (auto &entry : conns) finalize_now(entry.second, 1006, "shutdown-flush-timeout");
        conns.clear();
        break;
      }

      struct PollEntry {
        int fd;
        std::uint32_t id;
        bool is_listener;
        bool is_wake;
      };
      std::vector<pollfd> fds;
      std::vector<PollEntry> entries;
      {
        std::lock_guard<std::mutex> lock(mu);
        if (!stopping) {
          fds.push_back({listen_fd, POLLIN, 0});
          entries.push_back({listen_fd, 0, true, false});
        }
        fds.push_back({wake_r, POLLIN, 0});
        entries.push_back({wake_r, 0, false, true});
        for (auto &entry : conns) {
          short want = POLLIN;
          if (entry.second.send_off < entry.second.send_buf.size()) want |= POLLOUT;
          fds.push_back({entry.second.fd, want, 0});
          entries.push_back({entry.second.fd, entry.first, false, false});
        }
      }

      const int n = ::poll(fds.data(), fds.size(), 50);
      if (n < 0) {
        if (errno == EINTR) continue;
        break;
      }
      if (n == 0) continue;

      for (std::size_t i = 0; i < fds.size(); ++i) {
        if (fds[i].revents == 0) continue;
        if (entries[i].is_wake) {
          while (::read(wake_r, drain, sizeof(drain)) > 0) {
          }
          continue;
        }
        if (entries[i].is_listener) {
          if (fds[i].revents & POLLIN) {
            std::lock_guard<std::mutex> lock(mu);
            accept_loop();
          }
          continue;
        }
        std::lock_guard<std::mutex> lock(mu);
        auto it = conns.find(entries[i].id);
        if (it == conns.end()) continue;
        Conn &c = it->second;
        if (fds[i].revents & (POLLHUP | POLLERR | POLLNVAL)) {
          finalize_now(c, 1006, "connection reset");
        } else {
          if (fds[i].revents & POLLOUT) try_flush(c);
          if (c.phase != Conn::Phase::Closed && (fds[i].revents & POLLIN)) handle_readable(c);
          maybe_finalize(c);
        }
        if (c.phase == Conn::Phase::Closed) conns.erase(it);
      }
    }

    std::lock_guard<std::mutex> lock(mu);
    for (auto &entry : conns) finalize_now(entry.second, 1006, "server-stopped");
    conns.clear();
  }

  bool enqueue_message(std::uint32_t id, std::vector<std::uint8_t> frame) {
    bool ok;
    {
      std::lock_guard<std::mutex> lock(mu);
      auto it = conns.find(id);
      if (it == conns.end() || it->second.phase != Conn::Phase::Open || it->second.shutdown_after_flush) {
        ok = false;
      } else if (enqueue_raw(it->second, std::move(frame), /*bypass_limit=*/false)) {
        it->second.sent_messages++;
        ok = true;
      } else {
        begin_close(it->second, 1008, "queued bytes exceeded");
        ok = false;
      }
    }
    wake();
    return ok;
  }
};

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

Server::Server() : impl_(std::make_unique<Impl>()) {}

Server::~Server() {
  if (!impl_) return;
  if (impl_->running.load()) stop(0);
  if (impl_->listen_fd >= 0) ::close(impl_->listen_fd);
  if (impl_->wake_r >= 0) ::close(impl_->wake_r);
  if (impl_->wake_w >= 0) ::close(impl_->wake_w);
}

bool Server::start(const ServerConfig &config, ResourceSource *source, std::string *error) {
  if (impl_->running.load()) {
    if (error) *error = "already started";
    return false;
  }

  sockaddr_in addr4{};
  sockaddr_in6 addr6{};
  int family = 0;
  if (config.host == "127.0.0.1") {
    family = AF_INET;
    addr4.sin_family = AF_INET;
    addr4.sin_port = htons(config.port);
    addr4.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  } else if (config.host == "::1") {
    family = AF_INET6;
    addr6.sin6_family = AF_INET6;
    addr6.sin6_port = htons(config.port);
    addr6.sin6_addr = in6addr_loopback;
  } else {
    if (error) *error = "non-loopback";
    return false;
  }

  const int fd = ::socket(family, SOCK_STREAM, 0);
  if (fd < 0) {
    if (error) *error = std::string("socket: ") + std::strerror(errno);
    return false;
  }
  const int one = 1;
  ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));

  const int bind_rc = (family == AF_INET)
                           ? ::bind(fd, reinterpret_cast<sockaddr *>(&addr4), sizeof(addr4))
                           : ::bind(fd, reinterpret_cast<sockaddr *>(&addr6), sizeof(addr6));
  if (bind_rc != 0) {
    if (error) *error = std::string("bind: ") + std::strerror(errno);
    ::close(fd);
    return false;
  }
  if (::listen(fd, 16) != 0) {
    if (error) *error = std::string("listen: ") + std::strerror(errno);
    ::close(fd);
    return false;
  }
  set_nonblocking(fd);

  sockaddr_storage bound{};
  socklen_t blen = sizeof(bound);
  ::getsockname(fd, reinterpret_cast<sockaddr *>(&bound), &blen);
  std::uint16_t bound_port =
      (family == AF_INET) ? ntohs(reinterpret_cast<sockaddr_in *>(&bound)->sin_port)
                           : ntohs(reinterpret_cast<sockaddr_in6 *>(&bound)->sin6_port);

  int pipe_fds[2];
  if (::pipe(pipe_fds) != 0) {
    if (error) *error = std::string("pipe: ") + std::strerror(errno);
    ::close(fd);
    return false;
  }
  set_nonblocking(pipe_fds[0]);
  set_nonblocking(pipe_fds[1]);

  impl_->config = config;
  impl_->resource_source = source;
  impl_->listen_fd = fd;
  impl_->wake_r = pipe_fds[0];
  impl_->wake_w = pipe_fds[1];
  impl_->bound_port = bound_port;
  impl_->stop_requested.store(false);
  impl_->running.store(true);
  impl_->io_thread = std::thread([this] { impl_->io_loop(); });
  return true;
}

std::uint16_t Server::port() const { return impl_->bound_port; }

std::vector<Event> Server::take_events() {
  std::lock_guard<std::mutex> lock(impl_->mu);
  std::vector<Event> out;
  std::swap(out, impl_->events);
  return out;
}

bool Server::send_binary(std::uint32_t conn, std::vector<std::uint8_t> message) {
  return impl_->enqueue_message(conn, encode_frame(0x2, message));
}

bool Server::send_text(std::uint32_t conn, std::string message) {
  return impl_->enqueue_message(conn, encode_frame(0x1, to_bytes(message)));
}

void Server::close(std::uint32_t conn, std::uint16_t code, std::string reason) {
  {
    std::lock_guard<std::mutex> lock(impl_->mu);
    auto it = impl_->conns.find(conn);
    if (it != impl_->conns.end()) impl_->begin_close(it->second, code, std::move(reason));
  }
  impl_->wake();
}

Server::ConnStats Server::stats(std::uint32_t conn) const {
  std::lock_guard<std::mutex> lock(impl_->mu);
  ConnStats out{};
  auto it = impl_->conns.find(conn);
  if (it == impl_->conns.end()) return out;
  const Conn &c = it->second;
  out.queued_bytes = c.send_buf.size() - c.send_off;
  out.max_queued_bytes = c.max_queued_bytes_seen;
  out.sent_bytes = c.sent_bytes;
  out.sent_messages = c.sent_messages;
  out.received_text = c.received_text;
  return out;
}

void Server::stop(int flush_timeout_ms) {
  if (!impl_->running.load()) return;
  {
    std::lock_guard<std::mutex> lock(impl_->mu);
    for (auto &entry : impl_->conns) {
      if (entry.second.phase == Conn::Phase::Open && !entry.second.shutdown_after_flush) {
        impl_->begin_close(entry.second, 1000, "shutdown");
      }
    }
  }
  impl_->flush_timeout_ms = flush_timeout_ms;
  impl_->stop_requested.store(true);
  impl_->wake();
  if (impl_->io_thread.joinable()) impl_->io_thread.join();
  impl_->running.store(false);
}

}  // namespace live
}  // namespace grc
