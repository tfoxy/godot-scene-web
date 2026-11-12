// Unit test for rs_ws (src/rs_ws.h), the dependency-free RFC 6455 server
// and its HTTP GET resource serving
//
// Covers:
//   - SHA-1 vectors (FIPS 180, "" and "abc").
//   - The RFC 6455 ssec 1.3 handshake vector, through a real handshake.
//   - Frame header encoding at the length-class boundaries (0, 125, 126,
//     65535, 65536, 2^24), plus one 4 MiB binary.
//   - Masking (an in-process raw-socket client sends masked text; an
//     unmasked frame is rejected).
//   - ping/pong, close, fragmentation (1002), binary inbound (1003), an
//     over-long text message (1009), the queued-bytes safety net (1008).
//   - Handshake errors: wrong path (404), missing subprotocol (400), a
//     malformed request (400), a client beyond max_clients (503).
//   - Non-loopback refusal.
//   - stop() flushing and closing.
//   - HTTP GET: 200 bodies byte-exact at several sizes, 304 via
//     If-None-Match, 400 on a malformed hash, 404 on an unknown hash, 405 on
//     a non-GET method with Allow: GET, 503 beyond max_http_clients,
//     keep-alive across two requests, Connection: close honoured, a
//     WebSocket session alongside HTTP fetches on the same port, and that
//     the built test binary imports neither mmap nor mprotect.
//   - Bearer-token authorization: constant_time_equals's own
//     correctness (equal, unequal, differing lengths, empty), a missing or wrong token on the WS
//     upgrade and on a resource GET both -> 401 (an AuthRejected event for the former, an
//     HttpGet 401 event for the latter), a correct token succeeds on both, and no auth_token
//     configured leaves every request unauthenticated-but-accepted as before G2e.
//   - The subprotocol choice (render-stream.7 preferred), the
//     /7 upgrade without a bearer header while /6 keeps it, the Origin allowlist (403 and one
//     OriginRejected event on the upgrade, GET and OPTIONS; exact matching), CORS headers on an
//     allowed GET (200, 404, 401), the exact 204 preflight for any hash, the accept-any-origin and
//     no-cors switches, and parse_allowed_origins.
//   - Track subprotocols: with no track_subprotocols a track upgrade is answered
//     byte for byte as an unknown subprotocol; with them, a track upgrade is 101 without the
//     bearer check, has its own max_tracks pool (503 past it while a view upgrade still succeeds),
//     and a client offering both a view and a track subprotocol gets the view one.
//   - CAR2 (Security): allow_non_loopback binds 0.0.0.0, "::" and a host
//     address and serves through a non-loopback address; a hostname still refuses; the Origin
//     allow-list holds there; and a malformed-input set (headers over 8 KiB, bad lengths,
//     reserved bits, unmasked and non-UTF-8 frames) is answered with the right status or close
//     code and leaves the server serving.
//
// The raw-socket client below is a second, independent implementation of
// the wire format (client side): it is deliberately not shared code with
// src/rs_ws.cpp, so a bug that is symmetric between encode and decode would
// not cancel out.

#include "rs_platform.h"

// Native client-only facilities; the listener itself uses rs_platform on every OS.
#ifdef _WIN32
#include <winsock2.h>
#else
#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "rs_http_coding.h"
#include "rs_net_module.h"
#include "rs_sha1.h"
#include "rs_ws.h"

#ifdef GRC_TEST_OPENSSL
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>
#endif

namespace {

using grc::rs::SocketHandle;
using grc::rs::kInvalidSocket;

int g_failures = 0;
int g_checks = 0;

void check(bool condition, const std::string &what) {
  ++g_checks;
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
    ++g_failures;
  }
}

std::string hex(const std::uint8_t *data, std::size_t len) {
  static const char *digits = "0123456789abcdef";
  std::string out(len * 2, '0');
  for (std::size_t i = 0; i < len; ++i) {
    out[2 * i] = digits[(data[i] >> 4) & 0xF];
    out[2 * i + 1] = digits[data[i] & 0xF];
  }
  return out;
}

// --- A minimal, independent raw-socket WebSocket client for the test. ---

void client_timeouts(SocketHandle fd, bool send_timeout) {
#ifdef _WIN32
  const DWORD timeout = 5000;
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&timeout), sizeof(timeout));
  if (send_timeout)
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char *>(&timeout), sizeof(timeout));
#else
  timeval timeout{};
  timeout.tv_sec = 5;
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  if (send_timeout) ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
#endif
}

// Winsock has no per-send MSG_DONTWAIT: only the flood client becomes nonblocking.
void client_prepare_flood(SocketHandle fd) {
#ifdef _WIN32
  grc::rs::set_nonblocking(fd);
#else
  (void)fd;
#endif
}

std::ptrdiff_t client_flood_send(SocketHandle fd, const void *data, std::size_t size) {
#ifdef _WIN32
  return grc::rs::socket_send(fd, data, size);
#else
  return ::send(fd, data, size, MSG_NOSIGNAL | MSG_DONTWAIT);
#endif
}

bool client_connection_closed(int code) {
#ifdef _WIN32
  return code == WSAECONNRESET || code == WSAECONNABORTED || code == WSAESHUTDOWN || code == WSAENOTCONN;
#else
  return code == EPIPE || code == ECONNRESET;
#endif
}

bool client_socket_error(SocketHandle fd, int *code) {
#ifdef _WIN32
  int size = sizeof(*code);
  return ::getsockopt(fd, SOL_SOCKET, SO_ERROR, reinterpret_cast<char *>(code), &size) == 0;
#else
  socklen_t size = sizeof(*code);
  return ::getsockopt(fd, SOL_SOCKET, SO_ERROR, code, &size) == 0;
#endif
}

SocketHandle connect_loopback(std::uint16_t port) {
  const auto fd = grc::rs::tcp_connect(grc::rs::loopback_address(grc::rs::AddrFamily::IPv4), port, nullptr);
  if (fd != kInvalidSocket) client_timeouts(fd, true);
  return fd;
}

bool recv_exact(SocketHandle fd, std::uint8_t *buf, std::size_t len) {
  std::size_t have = 0;
  while (have < len) {
    const std::ptrdiff_t n = grc::rs::socket_recv(fd, buf + have, len - have);
    if (n <= 0) return false;
    have += static_cast<std::size_t>(n);
  }
  return true;
}

// Reads whatever is available right now (one recv call, with the socket's
// receive timeout), for reading an HTTP response or a short error frame.
std::vector<std::uint8_t> recv_some(SocketHandle fd) {
  std::uint8_t buf[8192];
  const std::ptrdiff_t n = grc::rs::socket_recv(fd, buf, sizeof(buf));
  if (n <= 0) return {};
  return std::vector<std::uint8_t>(buf, buf + n);
}

std::string http_request(const std::string &key, const std::string &path, const std::string &subprotocol_header,
                          const std::vector<std::pair<std::string, std::string>> &extra_headers = {}) {
  std::string req = "GET " + path + " HTTP/1.1\r\n";
  req += "Host: 127.0.0.1\r\n";
  req += "Upgrade: websocket\r\n";
  req += "Connection: Upgrade\r\n";
  req += "Sec-WebSocket-Key: " + key + "\r\n";
  req += "Sec-WebSocket-Version: 13\r\n";
  if (!subprotocol_header.empty()) req += "Sec-WebSocket-Protocol: " + subprotocol_header + "\r\n";
  for (const auto &h : extra_headers) req += h.first + ": " + h.second + "\r\n";
  req += "\r\n";
  return req;
}

// Client -> server frames must be masked.
std::vector<std::uint8_t> client_frame(std::uint8_t opcode, const std::vector<std::uint8_t> &payload, bool fin = true,
                                        bool masked = true, std::uint32_t mask_key = 0x01020304) {
  std::vector<std::uint8_t> out;
  out.push_back(static_cast<std::uint8_t>((fin ? 0x80 : 0x00) | (opcode & 0x0F)));
  const std::size_t len = payload.size();
  const std::uint8_t mask_bit = masked ? 0x80 : 0x00;
  if (len < 126) {
    out.push_back(static_cast<std::uint8_t>(mask_bit | len));
  } else if (len <= 0xFFFF) {
    out.push_back(static_cast<std::uint8_t>(mask_bit | 126));
    out.push_back(static_cast<std::uint8_t>((len >> 8) & 0xFF));
    out.push_back(static_cast<std::uint8_t>(len & 0xFF));
  } else {
    out.push_back(static_cast<std::uint8_t>(mask_bit | 127));
    for (int i = 7; i >= 0; --i) out.push_back(static_cast<std::uint8_t>((static_cast<std::uint64_t>(len) >> (8 * i)) & 0xFF));
  }
  std::uint8_t mask[4] = {
      static_cast<std::uint8_t>((mask_key >> 24) & 0xFF),
      static_cast<std::uint8_t>((mask_key >> 16) & 0xFF),
      static_cast<std::uint8_t>((mask_key >> 8) & 0xFF),
      static_cast<std::uint8_t>(mask_key & 0xFF),
  };
  if (masked) out.insert(out.end(), mask, mask + 4);
  for (std::size_t i = 0; i < len; ++i) {
    out.push_back(masked ? static_cast<std::uint8_t>(payload[i] ^ mask[i % 4]) : payload[i]);
  }
  return out;
}

std::vector<std::uint8_t> client_text(const std::string &text, bool fin = true, bool masked = true) {
  return client_frame(0x1, std::vector<std::uint8_t>(text.begin(), text.end()), fin, masked);
}

struct ServerFrame {
  bool ok = false;
  bool fin = false;
  std::uint8_t opcode = 0;
  std::vector<std::uint8_t> payload;
  std::size_t header_len = 0;  // for the length-class assertions.
};

// Reads exactly one outbound (unmasked) server frame.
ServerFrame read_server_frame(SocketHandle fd) {
  ServerFrame out;
  std::uint8_t head[2];
  if (!recv_exact(fd, head, 2)) return out;
  out.fin = (head[0] & 0x80) != 0;
  out.opcode = head[0] & 0x0F;
  const bool masked = (head[1] & 0x80) != 0;
  if (masked) return out;  // the server must never mask outbound frames.
  const std::uint8_t len7 = head[1] & 0x7F;
  std::uint64_t len = len7;
  std::size_t header_len = 2;
  if (len7 == 126) {
    std::uint8_t ext[2];
    if (!recv_exact(fd, ext, 2)) return out;
    len = (static_cast<std::uint64_t>(ext[0]) << 8) | ext[1];
    header_len += 2;
  } else if (len7 == 127) {
    std::uint8_t ext[8];
    if (!recv_exact(fd, ext, 8)) return out;
    len = 0;
    for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    header_len += 8;
  }
  out.payload.resize(static_cast<std::size_t>(len));
  if (len > 0 && !recv_exact(fd, out.payload.data(), out.payload.size())) return out;
  out.header_len = header_len;
  out.ok = true;
  return out;
}

struct Handshake {
  bool ok = false;
  int status = 0;
  std::string raw;
};

Handshake do_handshake(SocketHandle fd, const std::string &key, const std::string &path = "/render-stream",
                        const std::string &subprotocol_header = "render-stream.1",
                        const std::vector<std::pair<std::string, std::string>> &extra_headers = {}) {
  const std::string req = http_request(key, path, subprotocol_header, extra_headers);
  grc::rs::socket_send(fd, req.data(), req.size());
  Handshake out;
  const auto bytes = recv_some(fd);
  out.raw.assign(bytes.begin(), bytes.end());
  if (out.raw.rfind("HTTP/1.1 ", 0) == 0 && out.raw.size() >= 12) {
    out.status = std::atoi(out.raw.substr(9, 3).c_str());
    out.ok = true;
  }
  return out;
}

grc::live::Server::ConnStats wait_stats_until(grc::live::Server &server, std::uint32_t conn,
                                               bool (*pred)(const grc::live::Server::ConnStats &), int timeout_ms) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  grc::live::Server::ConnStats stats{};
  while (std::chrono::steady_clock::now() < deadline) {
    stats = server.stats(conn);
    if (pred(stats)) return stats;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  return stats;
}

std::vector<grc::live::Event> wait_events(grc::live::Server &server, std::size_t min_count, int timeout_ms) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  std::vector<grc::live::Event> out;
  while (std::chrono::steady_clock::now() < deadline) {
    for (auto &e : server.take_events()) out.push_back(std::move(e));
    if (out.size() >= min_count) return out;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  return out;
}

std::uint32_t expect_opened(grc::live::Server &server) {
  const auto events = wait_events(server, 1, 2000);
  if (events.empty() || events[0].kind != grc::live::Event::Opened) return 0;
  return events[0].conn;
}

// --- A fixed-table ResourceSource and a minimal raw-socket HTTP/1.1 client for the test. ---

// Exactly 64 of `fill` (a lowercase hex digit), so every string this returns is a well-formed
// resource hash shape regardless of whether FakeResourceSource actually holds it.
std::string make_hash(char fill) { return std::string(64, fill); }

// Deterministic, independent of rs_ws_echo.cpp's own pattern (different call sites, same idea):
// byte[i] = (seed + i * 31) % 256.
std::vector<std::uint8_t> pattern_bytes(std::size_t len, std::uint8_t seed) {
  std::vector<std::uint8_t> out(len);
  for (std::size_t i = 0; i < len; ++i) {
    out[i] = static_cast<std::uint8_t>((seed + i * 31) % 256);
  }
  return out;
}

class FakeResourceSource : public grc::live::ResourceSource {
 public:
  void set(const std::string &hash, std::vector<std::uint8_t> body) {
    bodies_[hash] = std::make_shared<const std::vector<std::uint8_t>>(std::move(body));
  }
  std::shared_ptr<const std::vector<std::uint8_t>> lookup(std::string_view hash) override {
    const auto it = bodies_.find(std::string(hash));
    return it == bodies_.end() ? nullptr : it->second;
  }

 private:
  std::map<std::string, std::shared_ptr<const std::vector<std::uint8_t>>> bodies_;
};

// G8kz: a source that also codes (what ServedResources does), counting its compressions.
class CodedResourceSource : public FakeResourceSource {
 public:
  std::shared_ptr<const std::vector<std::uint8_t>> lookup_coded(std::string_view hash,
                                                                grc::live::Coding coding) override {
    const auto identity = lookup(hash);
    if (identity == nullptr) return nullptr;
    std::vector<std::uint8_t> out;
    const bool ok = coding == grc::live::Coding::Zstd
                        ? grc::rs::http_coding::zstd_compress(identity->data(), identity->size(), &out)
                        : grc::rs::http_coding::gzip_compress(identity->data(), identity->size(), &out);
    ++compressions;
    if (!ok || out.size() >= identity->size()) return nullptr;
    return std::make_shared<const std::vector<std::uint8_t>>(std::move(out));
  }
  int compressions = 0;
};

std::string plain_http_request(const std::string &method, const std::string &path,
                                const std::vector<std::pair<std::string, std::string>> &headers = {}) {
  std::string req = method + " " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\n";
  for (const auto &h : headers) req += h.first + ": " + h.second + "\r\n";
  req += "\r\n";
  return req;
}

struct HttpResponse {
  bool ok = false;  // the full response (headers + declared body) was read before EOF/timeout.
  int status = 0;
  std::map<std::string, std::string> headers;  // lowercase keys, first occurrence kept.
  std::vector<std::uint8_t> body;
};

// Reads exactly one HTTP/1.1 response from `fd`: the status line and headers up to "\r\n\r\n",
// then exactly Content-Length body bytes (0 if the header is absent, which is every status this
// server sends without a body). Blocks, subject to the socket's receive timeout, until the
// response is complete, the peer closes, or the timeout fires.
HttpResponse read_http_response(SocketHandle fd) {
  HttpResponse out;
  std::vector<std::uint8_t> buf;
  std::uint8_t chunk[65536];
  std::size_t header_end = std::string::npos;
  for (;;) {
    for (std::size_t i = 0; i + 4 <= buf.size(); ++i) {
      if (buf[i] == '\r' && buf[i + 1] == '\n' && buf[i + 2] == '\r' && buf[i + 3] == '\n') {
        header_end = i;
        break;
      }
    }
    if (header_end != std::string::npos) break;
    const std::ptrdiff_t n = grc::rs::socket_recv(fd, chunk, sizeof(chunk));
    if (n <= 0) return out;  // closed or timed out before the headers completed.
    buf.insert(buf.end(), chunk, chunk + n);
  }
  const std::string head(buf.begin(), buf.begin() + static_cast<std::ptrdiff_t>(header_end));
  std::vector<std::uint8_t> body_so_far(buf.begin() + static_cast<std::ptrdiff_t>(header_end + 4), buf.end());

  std::size_t line_start = 0;
  bool first = true;
  while (line_start <= head.size()) {
    const std::size_t line_end = head.find("\r\n", line_start);
    const std::string line =
        head.substr(line_start, line_end == std::string::npos ? std::string::npos : line_end - line_start);
    if (first) {
      first = false;
      const std::size_t sp1 = line.find(' ');
      const std::size_t sp2 = sp1 == std::string::npos ? std::string::npos : line.find(' ', sp1 + 1);
      if (sp1 != std::string::npos) {
        out.status = std::atoi(line.substr(sp1 + 1, sp2 == std::string::npos ? std::string::npos : sp2 - sp1 - 1)
                                    .c_str());
      }
    } else if (!line.empty()) {
      const std::size_t colon = line.find(':');
      if (colon != std::string::npos) {
        std::string k = line.substr(0, colon);
        for (char &ch : k) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
        std::size_t vstart = colon + 1;
        while (vstart < line.size() && line[vstart] == ' ') ++vstart;
        out.headers.emplace(k, line.substr(vstart));
      }
    }
    if (line_end == std::string::npos) break;
    line_start = line_end + 2;
  }

  std::size_t content_length = 0;
  const auto it = out.headers.find("content-length");
  if (it != out.headers.end()) content_length = std::strtoul(it->second.c_str(), nullptr, 10);

  out.body = std::move(body_so_far);
  while (out.body.size() < content_length) {
    const std::ptrdiff_t n = grc::rs::socket_recv(fd, chunk, sizeof(chunk));
    if (n <= 0) return out;  // incomplete: ok stays false.
    out.body.insert(out.body.end(), chunk, chunk + n);
  }
  out.ok = true;
  return out;
}

// ---------------------------------------------------------------------------

void test_sha1_vectors() {
  const auto empty = grc::sha1(std::string(""));
  check(hex(empty.data(), empty.size()) == "da39a3ee5e6b4b0d3255bfef95601890afd80709", "sha1('')");
  const auto abc = grc::sha1(std::string("abc"));
  check(hex(abc.data(), abc.size()) == "a9993e364706816aba3e25717850c26c9cd0d89d", "sha1('abc')");
}

void test_handshake_accept_key_rfc_vector() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);

  const SocketHandle fd = connect_loopback(server.port());
  check(fd != kInvalidSocket, "connect for RFC vector");
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(hs.status == 101, "RFC vector handshake status 101");
  check(hs.raw.find("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") != std::string::npos,
        "RFC 6455 ssec 1.3 accept key: got " + hs.raw);
  check(hs.raw.find("Sec-WebSocket-Protocol: render-stream.1") != std::string::npos, "subprotocol echoed");
  check(expect_opened(server) != 0, "Opened event after a good handshake");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_masked_text_roundtrip() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for text roundtrip");

  const auto frame = client_text("hello render-stream");
  grc::rs::socket_send(fd, frame.data(), frame.size());
  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events[0].kind == grc::live::Event::Text && events[0].text == "hello render-stream",
        "masked text arrives as a Text event");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_frame_header_length_classes() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for length classes");

  const std::size_t lengths[] = {0, 125, 126, 65535, 65536, 1u << 24};
  const std::size_t expected_header_len[] = {2, 2, 4, 4, 10, 10};
  for (std::size_t i = 0; i < 6; ++i) {
    std::vector<std::uint8_t> payload(lengths[i]);
    for (std::size_t j = 0; j < payload.size(); ++j) payload[j] = static_cast<std::uint8_t>(j % 256);
    check(server.send_binary(conn, payload), "send_binary at length " + std::to_string(lengths[i]));
    const ServerFrame frame = read_server_frame(fd);
    check(frame.ok, "frame decodes at length " + std::to_string(lengths[i]));
    check(frame.fin && frame.opcode == 0x2, "fin+binary opcode at length " + std::to_string(lengths[i]));
    check(frame.header_len == expected_header_len[i],
          "header length at payload " + std::to_string(lengths[i]) + ": got " + std::to_string(frame.header_len));
    check(frame.payload == payload, "payload byte-exact at length " + std::to_string(lengths[i]));
  }
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_ping_pong() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened for ping/pong");

  const std::vector<std::uint8_t> ping_payload = {'p', 'i', 'n', 'g', '!'};
  const auto frame = client_frame(0x9, ping_payload);
  grc::rs::socket_send(fd, frame.data(), frame.size());
  const ServerFrame pong = read_server_frame(fd);
  check(pong.ok && pong.opcode == 0xA && pong.payload == ping_payload, "pong echoes the ping payload");
  check(wait_events(server, 1, 300).empty(), "ping/pong produces no Event");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_close_handshake() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for close");

  std::vector<std::uint8_t> close_payload = {0x03, 0xE8};  // 1000, big-endian, no reason.
  const auto frame = client_frame(0x8, close_payload);
  grc::rs::socket_send(fd, frame.data(), frame.size());
  const ServerFrame echoed = read_server_frame(fd);
  check(echoed.ok && echoed.opcode == 0x8, "server echoes a close frame");
  check(echoed.payload.size() >= 2 && echoed.payload[0] == 0x03 && echoed.payload[1] == 0xE8,
        "echoed close code is 1000");

  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events.back().kind == grc::live::Event::Closed && events.back().code == 1000,
        "Closed event with code 1000 after a peer-initiated close");

  std::uint8_t probe;
  const std::ptrdiff_t n = grc::rs::socket_recv(fd, &probe, 1);
  check(n == 0, "TCP connection actually closes after the close handshake");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

// Reads through the final FIN as well as the frame/response: a reset can arrive after all
// application bytes, so successfully decoding them alone does not prove a graceful close.
void expect_clean_eof(SocketHandle fd, const std::string &label) {
  std::uint8_t probe;
  const std::ptrdiff_t n = grc::rs::socket_recv(fd, &probe, 1);
  const int recv_error = n < 0 ? grc::rs::last_socket_error().code : 0;
  int socket_error = 0;
  const bool queried = client_socket_error(fd, &socket_error);
  check(n == 0 && queried && socket_error == 0,
        label + ": EOF, recv=" + std::to_string(n) + " error=" + std::to_string(recv_error) +
            " (" + grc::rs::socket_error_text(recv_error) + "), socket error=" + std::to_string(socket_error) +
            " (" + grc::rs::socket_error_text(socket_error) + ")");
}

int closed_count(const std::vector<grc::live::Event> &events, std::uint32_t conn) {
  int count = 0;
  for (const auto &e : events) {
    if (e.conn == conn && e.kind == grc::live::Event::Closed) ++count;
  }
  return count;
}

// Short sleeps can round up to a full timer tick. Keep the trailing send loop
// comfortably inside the server's one-second linger deadline on every OS.
void pause_one_millisecond() {
  const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(1);
  while (std::chrono::steady_clock::now() < until) std::this_thread::yield();
}

void test_close_while_client_sends() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "linger WS server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  check(do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==").status == 101, "linger WS upgrade");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "linger WS opened");
  std::atomic<bool> started{false};
  std::atomic<bool> closing{false};
  double trailing_ms = 0;
  int sent_after_close = 0;
  int first_send_error = 0;
  std::thread writer([&] {
    const auto frame = client_text(std::string(1024, 'x'));
    do {
      grc::rs::socket_send(fd, frame.data(), frame.size());
      started.store(true);
      pause_one_millisecond();
    } while (!closing.load());
    const auto trailing_start = std::chrono::steady_clock::now();
    for (int i = 0; i < 100; ++i) {
      if (grc::rs::socket_send(fd, frame.data(), frame.size()) == static_cast<std::ptrdiff_t>(frame.size())) {
        ++sent_after_close;
      } else if (first_send_error == 0) {
        first_send_error = grc::rs::last_socket_error().code;
      }
      pause_one_millisecond();
    }
    trailing_ms = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - trailing_start).count();
  });
  while (!started.load()) std::this_thread::yield();
  check(server.send_text(conn, "final text"), "linger WS queues final text");
  server.close(conn, 1008, "track-rate");
  closing.store(true);
  writer.join();
  std::printf("linger WS 100 trailing frames: %.3f ms (bound < 500 ms)\n", trailing_ms);
  check(trailing_ms < 500, "linger WS trailing loop finishes within half the 1000 ms linger deadline, ms=" +
                               std::to_string(trailing_ms));
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  const ServerFrame text = read_server_frame(fd);
  check(text.ok && text.opcode == 1 && std::string(text.payload.begin(), text.payload.end()) == "final text",
        "linger WS receives complete final text");
  const ServerFrame close = read_server_frame(fd);
  const std::vector<std::uint8_t> expected = {0x03, 0xf0, 't', 'r', 'a', 'c', 'k', '-', 'r', 'a', 't', 'e'};
  check(close.ok && close.opcode == 8 && close.payload == expected,
        "linger WS receives complete close 1008 track-rate");
  expect_clean_eof(fd, "linger WS");
  check(sent_after_close == 100, "linger WS accepts 100 trailing client frames, first errno=" +
                                    std::to_string(first_send_error) + " (" + grc::rs::socket_error_text(first_send_error) + ")");
  auto events = server.take_events();
  check(closed_count(events, conn) == 1, "linger WS exactly one Closed at flush");
  bool after_closed = false;
  for (const auto &e : events) {
    if (e.conn != conn) continue;
    if (e.kind == grc::live::Event::Closed) {
      after_closed = true;
      check(e.code == 1008 && e.reason == "track-rate", "linger WS Closed retains code and reason");
    } else {
      check(!after_closed, "linger WS no events after Closed");
    }
  }
  grc::rs::socket_close(fd);
  const auto start = std::chrono::steady_clock::now();
  server.stop(1500);
  const double wall_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
  std::printf("linger WS stop(1500): %.3f ms\n", wall_ms);
  check(wall_ms < 2000, "linger WS stop bounded");
  check(closed_count(server.take_events(), conn) == 0, "linger WS no duplicate Closed at peer FIN/stop");
}

void test_http_close_with_trailing_bytes(bool reject) {
  FakeResourceSource source;
  const std::string hash = make_hash('a');
  const auto body = pattern_bytes(16384, 7);
  source.set(hash, body);
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  const std::string label = reject ? "linger HTTP reject 404" : "linger HTTP 200";
  check(server.start(config, &source, &error), label + " server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  // More than handle_readable's buffer: there must be unread kernel input when the
  // response flushes, even if the whole first recv contains the request and some junk.
  const std::string request = plain_http_request("GET", reject ? "/unknown" : config.resource_prefix + hash,
                                                 {{"Connection", "close"}}) + std::string(256 * 1024, 'x');
  grc::rs::socket_send(fd, request.data(), request.size());
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  const HttpResponse response = read_http_response(fd);
  check(response.ok && response.status == (reject ? 404 : 200) &&
            response.body == (reject ? std::vector<std::uint8_t>{} : body), label + " complete response");
  expect_clean_eof(fd, label);
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_linger_releases_slots_and_stop() {
  // Keep the old peer open after receiving our FIN: the replacement must be admitted
  // before the linger expires, and the old connection must already be absent from the API.
  for (bool track : {false, true}) {
    grc::live::Server server;
    grc::live::ServerConfig config;
    config.max_clients = 1;
    config.max_tracks = 1;
    config.track_subprotocols = {"render-stream-track.1"};
    const std::string protocol = track ? "render-stream-track.1" : "render-stream.1";
    std::string error;
    check(server.start(config, nullptr, &error), "linger slot server starts: " + error);
    const SocketHandle fd = connect_loopback(server.port());
    check(do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", config.path, protocol).status == 101,
          "linger slot first upgrade");
    const std::uint32_t conn = expect_opened(server);
    server.close(conn, 1008, "track-rate");
    check(read_server_frame(fd).opcode == 8, "linger slot close frame");
    expect_clean_eof(fd, "linger slot");
    check(closed_count(wait_events(server, 1, 2000), conn) == 1, "linger slot Closed at flush");
    check(!server.send_text(conn, "no") && !server.send_binary(conn, {1}), "linger absent from send API");
    server.close(conn, 1000, "ignored");
    const auto stats = server.stats(conn);
    check(stats.queued_bytes == 0 && stats.max_queued_bytes == 0 && stats.sent_bytes == 0 &&
              stats.sent_messages == 0 && stats.received_text == 0, "linger stats are zero");
    const SocketHandle replacement = connect_loopback(server.port());
    check(do_handshake(replacement, "dGhlIHNhbXBsZSBub25jZQ==", config.path, protocol).status == 101,
          track ? "linger frees max_tracks slot" : "linger frees max_clients slot");
    const auto opened = expect_opened(server);
    check(opened != 0, "linger replacement opened");
    const auto start = std::chrono::steady_clock::now();
    server.stop(0);
    const double wall_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::printf("linger %s stop(0), peer never FIN: %.3f ms\n", track ? "track" : "view", wall_ms);
    check(wall_ms < 500, "linger stop(0) returns promptly");
    const auto events = server.take_events();
    check(closed_count(events, conn) == 0 && closed_count(events, opened) == 1,
          "linger stop timeout pushes no duplicate Closed");
    grc::rs::socket_close(fd);
    grc::rs::socket_close(replacement);
  }
  FakeResourceSource source;
  const std::string hash = make_hash('b');
  source.set(hash, {1, 2, 3});
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.max_http_clients = 1;
  std::string error;
  check(server.start(config, &source, &error), "linger HTTP slot server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const std::string request = plain_http_request("GET", config.resource_prefix + hash, {{"Connection", "close"}});
  grc::rs::socket_send(fd, request.data(), request.size());
  check(read_http_response(fd).status == 200, "linger HTTP slot first GET");
  expect_clean_eof(fd, "linger HTTP slot");
  const SocketHandle replacement = connect_loopback(server.port());
  const std::string next = plain_http_request("GET", config.resource_prefix + hash);
  grc::rs::socket_send(replacement, next.data(), next.size());
  check(read_http_response(replacement).status == 200, "linger frees max_http_clients slot");
  server.stop(0);
  grc::rs::socket_close(fd);
  grc::rs::socket_close(replacement);
}

void test_linger_deadline_and_admission() {
  class CountingAdmission : public grc::live::Admission {
   public:
    std::atomic<int> held{0};
    std::atomic<int> releases{0};
    bool admit(grc::live::AdmissionPool) override { return held.exchange(1) == 0; }
    void release(grc::live::AdmissionPool) override { held.store(0); ++releases; }
  } admission;
  for (int timeout : {2000, 120}) {
    grc::live::Server server;
    grc::live::ServerConfig config;
    config.admission = &admission;
    std::string error;
    check(server.start(config, nullptr, &error), "linger deadline server starts: " + error);
    const SocketHandle fd = connect_loopback(server.port());
    check(do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==").status == 101, "linger deadline upgrade");
    const std::uint32_t conn = expect_opened(server);
    server.close(conn, 1008, "track-rate");
    check(read_server_frame(fd).opcode == 8, "linger deadline close frame");
    expect_clean_eof(fd, "linger deadline");
    check(closed_count(wait_events(server, 1, 2000), conn) == 1, "linger deadline Closed at flush");
    check(admission.held.load() == 0, "linger admission released at flush");
    const int releases = admission.releases.load();
    const auto start = std::chrono::steady_clock::now();
    server.stop(timeout);  // The client never sends FIN; the idle poll sweep must run.
    const double wall_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::printf("linger stop(%d), peer never FIN: %.3f ms\n", timeout, wall_ms);
    check(wall_ms < (timeout == 2000 ? 1800 : 600), "linger stop bounded by linger/flush deadline");
    check(admission.releases.load() == releases && closed_count(server.take_events(), conn) == 0,
          "linger deadline/stop sweep releases and reports exactly once");
    grc::rs::socket_close(fd);
  }
}

void test_linger_flood(bool stop_now) {
  class CountingAdmission : public grc::live::Admission {
   public:
    std::atomic<int> held{0};
    std::atomic<int> releases{0};
    bool admit(grc::live::AdmissionPool) override { return held.exchange(1) == 0; }
    void release(grc::live::AdmissionPool) override { held.store(0); ++releases; }
  } admission;
  const std::string label = stop_now ? "linger flood stop(0)" : "linger flood deadline";
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.admission = &admission;
  std::string error;
  check(server.start(config, nullptr, &error), label + " server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  check(do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==").status == 101, label + " upgrade");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0 && admission.held.load() == 1, label + " admitted once");
  server.close(conn, 1008, "track-rate");
  const ServerFrame close = read_server_frame(fd);
  const std::vector<std::uint8_t> expected = {0x03, 0xf0, 't', 'r', 'a', 'c', 'k', '-', 'r', 'a', 't', 'e'};
  check(close.ok && close.opcode == 8 && close.payload == expected, label + " close frame");
  check(closed_count(wait_events(server, 1, 2000), conn) == 1, label + " exactly one Closed at flush");
  check(admission.held.load() == 0 && admission.releases.load() == 1, label + " admission released at flush");

  // Never send FIN. Keep the receive queue busy after the close frame, without blocking
  // a writer on a full socket. The safety deadline also bounds a regressed stop() call.
  const auto start = std::chrono::steady_clock::now();
  std::atomic<bool> sending{true};
  std::atomic<int> active{0};
  std::atomic<int> send_error{0};
  client_prepare_flood(fd);
  std::vector<std::thread> writers;
  for (int i = 0; i < 4; ++i) {
    writers.emplace_back([&] {
      const std::vector<std::uint8_t> tail(65536, 'x');
      bool wrote = false;
      while (sending.load() && std::chrono::steady_clock::now() - start < std::chrono::seconds(3)) {
        // Prime each writer with one byte before flooding, so a single writer
        // cannot monopolize the socket's send buffer before the others start.
        const std::ptrdiff_t n = client_flood_send(fd, tail.data(), wrote ? tail.size() : 1);
        const auto error = n < 0 ? grc::rs::last_socket_error() : grc::rs::SocketError{grc::rs::SockErr::None, 0};
        if (n > 0) {
          if (!wrote) {
            wrote = true;
            ++active;
            while (active.load() < 4 && sending.load() &&
                   std::chrono::steady_clock::now() - start < std::chrono::seconds(3)) {
              std::this_thread::yield();
            }
          }
        } else if (n < 0 && (error.kind == grc::rs::SockErr::WouldBlock || error.kind == grc::rs::SockErr::Interrupted)) {
          std::this_thread::yield();
        } else {
          int unset = 0;
          send_error.compare_exchange_strong(unset, n < 0 ? error.code : -1);
          break;
        }
      }
    });
  }
  while (active.load() < 4 && std::chrono::steady_clock::now() - start < std::chrono::milliseconds(200)) {
    pause_one_millisecond();
  }
  check(active.load() == 4, label + " all four writers sent trailing bytes");
  double wall_ms;
  if (stop_now) {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    const auto stop_start = std::chrono::steady_clock::now();
    server.stop(0);
    wall_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - stop_start).count();
  } else {
    while (send_error.load() == 0 && std::chrono::steady_clock::now() - start < std::chrono::milliseconds(1600)) {
      pause_one_millisecond();
    }
    wall_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
  }
  sending.store(false);
  for (auto &writer : writers) writer.join();
  std::printf("%s, peer never FIN: %.3f ms, send error=%d (%s)\n", label.c_str(), wall_ms,
              send_error.load(), grc::rs::socket_error_text(send_error.load()).c_str());
  check(wall_ms < (stop_now ? 500 : 1500), label + " returns/closes within bound");
  if (!stop_now) {
    check(client_connection_closed(send_error.load()),
          label + " socket torn down while peer sends");
    check(closed_count(server.take_events(), conn) == 0 && admission.releases.load() == 1 &&
              admission.held.load() == 0, label + " deadline reports/releases no second time");
    server.stop(0);
  }
  check(closed_count(server.take_events(), conn) == 0 && admission.releases.load() == 1 &&
            admission.held.load() == 0, label + " stop reports/releases no second time");
  grc::rs::socket_close(fd);
}

void test_linger() {
  test_close_while_client_sends();
  test_http_close_with_trailing_bytes(false);
  test_http_close_with_trailing_bytes(true);
  test_linger_releases_slots_and_stop();
  test_linger_deadline_and_admission();
  test_linger_flood(false);
  test_linger_flood(true);
}

void test_fragmentation_rejected() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened for fragmentation");

  const auto frame = client_text("partial", /*fin=*/false);
  grc::rs::socket_send(fd, frame.data(), frame.size());
  const ServerFrame close_frame = read_server_frame(fd);
  check(close_frame.ok && close_frame.opcode == 0x8 && close_frame.payload.size() >= 2 &&
            ((static_cast<std::uint16_t>(close_frame.payload[0]) << 8) | close_frame.payload[1]) == 1002,
        "fragmentation closes with 1002");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_binary_inbound_rejected() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened for binary-inbound rejection");

  const auto frame = client_frame(0x2, {1, 2, 3, 4});
  grc::rs::socket_send(fd, frame.data(), frame.size());
  const ServerFrame close_frame = read_server_frame(fd);
  check(close_frame.ok && close_frame.opcode == 0x8 && close_frame.payload.size() >= 2 &&
            ((static_cast<std::uint16_t>(close_frame.payload[0]) << 8) | close_frame.payload[1]) == 1003,
        "binary inbound closes with 1003");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_unmasked_inbound_rejected() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened for unmasked rejection");

  const auto frame = client_text("not masked", /*fin=*/true, /*masked=*/false);
  grc::rs::socket_send(fd, frame.data(), frame.size());
  const ServerFrame close_frame = read_server_frame(fd);
  check(close_frame.ok && close_frame.opcode == 0x8 && close_frame.payload.size() >= 2 &&
            ((static_cast<std::uint16_t>(close_frame.payload[0]) << 8) | close_frame.payload[1]) == 1002,
        "unmasked inbound closes with 1002");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_text_too_long() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.max_inbound_text = 16;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened for too-long text");

  const auto frame = client_text("this text is longer than sixteen bytes");
  grc::rs::socket_send(fd, frame.data(), frame.size());
  const ServerFrame close_frame = read_server_frame(fd);
  check(close_frame.ok && close_frame.opcode == 0x8 && close_frame.payload.size() >= 2 &&
            ((static_cast<std::uint16_t>(close_frame.payload[0]) << 8) | close_frame.payload[1]) == 1009,
        "over-long text closes with 1009");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_wrong_path_404() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/wrong-path");
  check(hs.status == 404, "wrong path -> 404, got " + std::to_string(hs.status));
  check(wait_events(server, 1, 300).empty(), "a rejected handshake pushes no event");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_missing_subprotocol_400() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", /*subprotocol_header=*/"");
  check(hs.status == 400, "missing subprotocol -> 400, got " + std::to_string(hs.status));
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_malformed_request_400() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const std::string garbage = "not even http\r\n\r\n";
  grc::rs::socket_send(fd, garbage.data(), garbage.size());
  const auto bytes = recv_some(fd);
  const std::string raw(bytes.begin(), bytes.end());
  check(raw.rfind("HTTP/1.1 400", 0) == 0, "malformed request -> 400, got " + raw);
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_max_clients_503() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.max_clients = 1;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);

  const SocketHandle fd1 = connect_loopback(server.port());
  const Handshake hs1 = do_handshake(fd1, "dGhlIHNhbXBsZSBub25jZQ==");
  check(hs1.status == 101, "first client admitted");
  check(expect_opened(server) != 0, "first client opened");

  const SocketHandle fd2 = connect_loopback(server.port());
  const Handshake hs2 = do_handshake(fd2, "AAAAAAAAAAAAAAAAAAAAAA==");
  check(hs2.status == 503, "second client over max_clients -> 503, got " + std::to_string(hs2.status));

  grc::rs::socket_close(fd1);
  grc::rs::socket_close(fd2);
  server.stop(1000);
}

void test_non_loopback_refused() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.host = "0.0.0.0";
  std::string error;
  check(!server.start(config, nullptr, &error), "non-loopback host refuses to start");
  check(error == "non-loopback", "non-loopback error reason, got '" + error + "'");

  grc::live::Server server2;
  grc::live::ServerConfig config2;
  config2.host = "example.com";
  std::string error2;
  check(!server2.start(config2, nullptr, &error2), "a hostname refuses to start");
  check(error2 == "non-loopback", "hostname error reason, got '" + error2 + "'");
}

void test_queued_bytes_safety_net() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.max_queued_bytes = 1024;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for queue limit");

  const std::vector<std::uint8_t> big(4096, 0x42);
  check(!server.send_binary(conn, big), "a single send over max_queued_bytes is refused");
  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events.back().kind == grc::live::Event::Closed && events.back().code == 1008,
        "queued-bytes overflow closes with 1008");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_stats_track_sent_bytes() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for stats");

  check(server.send_text(conn, "abc"), "send_text for stats");
  const auto stats = wait_stats_until(
      server, conn, +[](const grc::live::Server::ConnStats &s) { return s.sent_messages >= 1; }, 2000);
  check(stats.sent_messages == 1, "sent_messages == 1");
  check(stats.sent_bytes >= 5, "sent_bytes includes the frame header");
  check(server.stats(999999).sent_messages == 0, "stats() for an unknown connection is zero");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_large_binary_4mib() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for 4 MiB binary");

  const std::size_t len = 4u << 20;
  std::vector<std::uint8_t> payload(len);
  for (std::size_t i = 0; i < len; ++i) payload[i] = static_cast<std::uint8_t>((i * 31 + 7) % 256);
  check(server.send_binary(conn, payload), "send_binary 4 MiB");
  const ServerFrame frame = read_server_frame(fd);
  check(frame.ok && frame.opcode == 0x2 && frame.payload == payload, "4 MiB binary arrives byte-exact");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_stop_closes_open_connections() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened before stop()");

  server.stop(2000);
  const ServerFrame close_frame = read_server_frame(fd);
  check(close_frame.ok && close_frame.opcode == 0x8 && close_frame.payload.size() >= 2 &&
            ((static_cast<std::uint16_t>(close_frame.payload[0]) << 8) | close_frame.payload[1]) == 1000,
        "stop() sends close 1000 to an open connection");
  std::uint8_t probe;
  check(grc::rs::socket_recv(fd, &probe, 1) == 0, "stop() actually closes the TCP connection");
  grc::rs::socket_close(fd);
}

// --- HTTP GET resource serving. ---

void test_http_get_sizes_byte_exact() {
  FakeResourceSource source;
  const std::size_t sizes[] = {0, 1, 65536, 4u << 20};
  std::string hashes[] = {make_hash('0'), make_hash('1'), make_hash('2'), make_hash('3')};
  for (std::size_t i = 0; i < 4; ++i) source.set(hashes[i], pattern_bytes(sizes[i], static_cast<std::uint8_t>(i)));

  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);

  for (std::size_t i = 0; i < 4; ++i) {
    const SocketHandle fd = connect_loopback(server.port());
    check(fd != kInvalidSocket, "connect for size " + std::to_string(sizes[i]));
    const std::string req = plain_http_request("GET", config.resource_prefix + hashes[i]);
    grc::rs::socket_send(fd, req.data(), req.size());
    const HttpResponse resp = read_http_response(fd);
    check(resp.ok, "response complete for size " + std::to_string(sizes[i]));
    check(resp.status == 200, "200 for size " + std::to_string(sizes[i]) + ": got " + std::to_string(resp.status));
    check(resp.headers.count("content-type") != 0 && resp.headers.at("content-type") == "application/octet-stream",
          "Content-Type for size " + std::to_string(sizes[i]));
    check(resp.headers.count("cache-control") != 0 &&
              resp.headers.at("cache-control") == "private, max-age=31536000, immutable",
          "Cache-Control immutable for size " + std::to_string(sizes[i]));
    check(resp.headers.count("etag") != 0 && resp.headers.at("etag") == "\"" + hashes[i] + "\"",
          "ETag for size " + std::to_string(sizes[i]));
    check(resp.body == pattern_bytes(sizes[i], static_cast<std::uint8_t>(i)),
          "byte-exact body for size " + std::to_string(sizes[i]));
    grc::rs::socket_close(fd);
  }
  server.stop(1000);
}

void test_http_404_unknown_hash() {
  FakeResourceSource source;
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const std::string req = plain_http_request("GET", config.resource_prefix + make_hash('e'));
  grc::rs::socket_send(fd, req.data(), req.size());
  const HttpResponse resp = read_http_response(fd);
  check(resp.ok && resp.status == 404, "unknown hash -> 404, got " + std::to_string(resp.status));
  check(resp.body.empty(), "404 body is empty");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_http_400_malformed_hash() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);

  const std::string bad_paths[] = {
      config.resource_prefix,                               // no hash at all
      config.resource_prefix + std::string(63, '0'),         // one short
      config.resource_prefix + std::string(65, '0'),         // one long
      config.resource_prefix + std::string(64, 'A'),         // uppercase
      config.resource_prefix + std::string(63, '0') + "g",   // non-hex
  };
  for (const std::string &path : bad_paths) {
    const SocketHandle fd = connect_loopback(server.port());
    const std::string req = plain_http_request("GET", path);
    grc::rs::socket_send(fd, req.data(), req.size());
    const HttpResponse resp = read_http_response(fd);
    check(resp.ok && resp.status == 400, "malformed hash '" + path + "' -> 400, got " + std::to_string(resp.status));
    grc::rs::socket_close(fd);
  }
  const auto events = wait_events(server, (sizeof(bad_paths) / sizeof(bad_paths[0])), 2000);
  check(events.size() == (sizeof(bad_paths) / sizeof(bad_paths[0])) && events.back().kind == grc::live::Event::HttpGet &&
            events.back().http_status == 400,
        "each malformed hash is also reported as an HttpGet 400 event");
  server.stop(1000);
}

void test_http_405_wrong_method() {
  FakeResourceSource source;
  const std::string hash = make_hash('4');
  source.set(hash, pattern_bytes(16, 7));
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const std::string req = plain_http_request("POST", config.resource_prefix + hash);
  grc::rs::socket_send(fd, req.data(), req.size());
  const HttpResponse resp = read_http_response(fd);
  check(resp.ok && resp.status == 405, "POST -> 405, got " + std::to_string(resp.status));
  check(resp.headers.count("allow") != 0 && resp.headers.at("allow") == "GET", "405 carries Allow: GET");
  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events[0].kind == grc::live::Event::HttpGet && events[0].hash == hash &&
            events[0].http_status == 405,
        "405 is also reported as an HttpGet event naming the attempted hash");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

// --- HTTP content coding. ---

void test_negotiate_coding() {
  using grc::live::Coding;
  using grc::live::negotiate_coding;
  const std::vector<Coding> both = {Coding::Zstd, Coding::Gzip};
  check(negotiate_coding("", both) == Coding::Identity, "no header: identity");
  check(negotiate_coding("zstd", {}) == Coding::Identity, "nothing offered: identity");
  check(negotiate_coding("zstd", both) == Coding::Zstd, "zstd");
  check(negotiate_coding("gzip, deflate, br, zstd", both) == Coding::Zstd, "a browser header: the host's order wins");
  check(negotiate_coding("gzip, deflate", both) == Coding::Gzip, "gzip only");
  check(negotiate_coding("br", both) == Coding::Identity, "an unknown coding only");
  check(negotiate_coding("zstd;q=0, gzip", both) == Coding::Gzip, "q=0 refuses zstd");
  check(negotiate_coding("zstd;q=0.5, gzip;q=0.9", {Coding::Zstd}) == Coding::Zstd, "a positive q is acceptable");
  check(negotiate_coding("*", both) == Coding::Zstd, "* accepts the first offered");
  check(negotiate_coding("*;q=0", both) == Coding::Identity, "*;q=0 refuses all");
  check(negotiate_coding("gzip;q=0, *", both) == Coding::Zstd, "* covers the unnamed zstd");
  check(negotiate_coding("ZSTD , GZIP", {Coding::Gzip}) == Coding::Gzip, "case and spaces");
  check(negotiate_coding("identity", both) == Coding::Identity, "identity only");
}

std::vector<std::uint8_t> compressible_bytes(std::size_t len) {
  std::vector<std::uint8_t> out(len);
  for (std::size_t i = 0; i < len; ++i) out[i] = static_cast<std::uint8_t>((i / 64) % 7);
  return out;
}

void test_http_content_coding() {
  CodedResourceSource source;
  const std::string hash = make_hash('a');
  const std::vector<std::uint8_t> identity = compressible_bytes(100000);
  source.set(hash, identity);
  const std::string tiny = make_hash('b');
  source.set(tiny, pattern_bytes(40, 3));  // random-ish: never smaller coded

  grc::live::Server server;
  grc::live::ServerConfig config;
  config.codings = {grc::live::Coding::Zstd};
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);
  const std::string path = config.resource_prefix + hash;

  const SocketHandle fd = connect_loopback(server.port());
  // 1. zstd negotiated.
  std::string req = plain_http_request("GET", path, {{"Accept-Encoding", "gzip, zstd"}});
  grc::rs::socket_send(fd, req.data(), req.size());
  HttpResponse resp = read_http_response(fd);
  check(resp.ok && resp.status == 200, "coded GET is 200");
  check(resp.headers.at("content-encoding") == "zstd", "Content-Encoding zstd");
  check(resp.headers.at("vary") == "Accept-Encoding", "Vary: Accept-Encoding");
  check(resp.headers.at("etag") == "\"" + hash + "-zstd\"", "per-coding ETag, got " + resp.headers.at("etag"));
  check(resp.headers.at("content-length") == std::to_string(resp.body.size()), "Content-Length is the coded length");
  check(resp.body.size() < identity.size() / 10, "the body is coded (smaller)");
  std::vector<std::uint8_t> decoded;
  check(grc::rs::http_coding::zstd_decompress(resp.body.data(), resp.body.size(), &decoded) && decoded == identity,
        "the coded body decodes to the identity bytes");
  const std::size_t coded_size = resp.body.size();
  // 2. No Accept-Encoding: identity, still Vary.
  req = plain_http_request("GET", path);
  grc::rs::socket_send(fd, req.data(), req.size());
  resp = read_http_response(fd);
  check(resp.ok && resp.status == 200 && resp.body == identity, "no Accept-Encoding: identity bytes");
  check(resp.headers.count("content-encoding") == 0, "no Content-Encoding on identity");
  check(resp.headers.at("etag") == "\"" + hash + "\"" && resp.headers.at("vary") == "Accept-Encoding",
        "identity ETag and Vary");
  // 3. gzip is not offered by this host.
  req = plain_http_request("GET", path, {{"Accept-Encoding", "gzip"}});
  grc::rs::socket_send(fd, req.data(), req.size());
  resp = read_http_response(fd);
  check(resp.ok && resp.body == identity && resp.headers.count("content-encoding") == 0,
        "a coding the host does not offer is identity");
  // 4. If-None-Match: identity and either coding's validator match; 304 carries the matched one.
  // TDR: a 304 is decided before any body is fetched (no compression, no inflate).
  const int before_304 = source.compressions;
  for (const std::string &tag : {"\"" + hash + "\"", "\"" + hash + "-zstd\"", "\"" + hash + "-gzip\""}) {
    req = plain_http_request("GET", path, {{"Accept-Encoding", "zstd"}, {"If-None-Match", "\"x\", " + tag}});
    grc::rs::socket_send(fd, req.data(), req.size());
    resp = read_http_response(fd);
    check(resp.ok && resp.status == 304 && resp.body.empty() && resp.headers.at("etag") == tag &&
              resp.headers.at("vary") == "Accept-Encoding",
          "304 for " + tag);
  }
  check(source.compressions == before_304, "a 304 touches no body");
  // 5. A body that is not smaller is served as identity.
  req = plain_http_request("GET", config.resource_prefix + tiny, {{"Accept-Encoding", "zstd"}});
  grc::rs::socket_send(fd, req.data(), req.size());
  resp = read_http_response(fd);
  check(resp.ok && resp.status == 200 && resp.headers.count("content-encoding") == 0 &&
            resp.headers.at("etag") == "\"" + tiny + "\"",
        "an incompressible body falls back to identity");
  grc::rs::socket_close(fd);
  // 6. Events: coding and coded bytes.
  const auto events = wait_events(server, 8, 2000);
  int coded_events = 0;
  for (const auto &e : events) {
    if (e.kind == grc::live::Event::HttpGet && e.http_status == 200 && e.coding == "zstd") {
      ++coded_events;
      check(e.bytes == identity.size() && e.coded_bytes == coded_size, "event: identity and coded bytes");
    }
  }
  check(coded_events == 1, "exactly one zstd 200 event");
  server.stop(1000);
}

void test_http_gzip_and_off_and_sabotage() {
  CodedResourceSource source;
  const std::string hash = make_hash('c');
  const std::vector<std::uint8_t> identity = compressible_bytes(50000);
  source.set(hash, identity);
  {
    grc::live::Server server;
    grc::live::ServerConfig config;
    config.codings = {grc::live::Coding::Gzip};
    std::string error;
    check(server.start(config, &source, &error), "gzip server starts: " + error);
    const SocketHandle fd = connect_loopback(server.port());
    const std::string req = plain_http_request("GET", config.resource_prefix + hash,
                                               {{"Accept-Encoding", "gzip, deflate, br, zstd"}});
    grc::rs::socket_send(fd, req.data(), req.size());
    const HttpResponse resp = read_http_response(fd);
    check(resp.ok && resp.headers.at("content-encoding") == "gzip" &&
              resp.headers.at("etag") == "\"" + hash + "-gzip\"",
          "gzip negotiated");
    std::vector<std::uint8_t> decoded;
    check(grc::rs::http_coding::gzip_decompress(resp.body.data(), resp.body.size(), &decoded) && decoded == identity,
          "gzip body decodes to identity");
    check(resp.body.size() >= 2 && resp.body[0] == 0x1f && resp.body[1] == 0x8b, "a real gzip header");
    grc::rs::socket_close(fd);
    server.stop(1000);
  }
  {
    grc::live::Server server;  // codings empty: today's bytes exactly, even for a client that asks
    grc::live::ServerConfig config;
    std::string error;
    check(server.start(config, &source, &error), "off server starts: " + error);
    const SocketHandle fd = connect_loopback(server.port());
    const std::string req = plain_http_request("GET", config.resource_prefix + hash, {{"Accept-Encoding", "zstd"}});
    grc::rs::socket_send(fd, req.data(), req.size());
    const HttpResponse resp = read_http_response(fd);
    check(resp.ok && resp.body == identity && resp.headers.count("content-encoding") == 0 &&
              resp.headers.count("vary") == 0 && resp.headers.at("etag") == "\"" + hash + "\"",
          "off: identity, no Vary, plain ETag");
    grc::rs::socket_close(fd);
    server.stop(1000);
  }
  {
    grc::live::Server server;
    grc::live::ServerConfig config;
    config.codings = {grc::live::Coding::Zstd};
    config.corrupt_coded_body = true;
    std::string error;
    check(server.start(config, &source, &error), "sabotage server starts: " + error);
    const SocketHandle fd = connect_loopback(server.port());
    const std::string req = plain_http_request("GET", config.resource_prefix + hash, {{"Accept-Encoding", "zstd"}});
    grc::rs::socket_send(fd, req.data(), req.size());
    const HttpResponse resp = read_http_response(fd);
    std::vector<std::uint8_t> decoded;
    const bool ok = grc::rs::http_coding::zstd_decompress(resp.body.data(), resp.body.size(), &decoded);
    check(resp.ok && resp.headers.at("content-encoding") == "zstd" && (!ok || decoded != identity),
          "corrupt-coded-body: the coded body no longer decodes to the identity bytes");
    grc::rs::socket_close(fd);
    server.stop(1000);
  }
}

void test_http_if_none_match_304() {
  FakeResourceSource source;
  const std::string hash = make_hash('5');
  source.set(hash, pattern_bytes(256, 9));
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);

  const SocketHandle fd = connect_loopback(server.port());
  const std::string req1 = plain_http_request("GET", config.resource_prefix + hash);
  grc::rs::socket_send(fd, req1.data(), req1.size());
  const HttpResponse resp1 = read_http_response(fd);
  check(resp1.ok && resp1.status == 200, "first GET is 200");

  const std::string req2 = plain_http_request("GET", config.resource_prefix + hash, {{"If-None-Match", "\"" + hash + "\""}});
  grc::rs::socket_send(fd, req2.data(), req2.size());
  const HttpResponse resp2 = read_http_response(fd);
  check(resp2.ok && resp2.status == 304, "If-None-Match -> 304, got " + std::to_string(resp2.status));
  check(resp2.body.empty(), "304 body is empty");
  check(resp2.headers.count("etag") != 0 && resp2.headers.at("etag") == "\"" + hash + "\"", "304 carries ETag");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_http_keep_alive_two_requests_one_connection() {
  FakeResourceSource source;
  const std::string hash_a = make_hash('6');
  const std::string hash_b = make_hash('7');
  source.set(hash_a, pattern_bytes(32, 1));
  source.set(hash_b, pattern_bytes(48, 2));
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);

  const SocketHandle fd = connect_loopback(server.port());
  const std::string req1 = plain_http_request("GET", config.resource_prefix + hash_a);
  grc::rs::socket_send(fd, req1.data(), req1.size());
  const HttpResponse resp1 = read_http_response(fd);
  check(resp1.ok && resp1.status == 200 && resp1.body == pattern_bytes(32, 1), "first request on the connection");

  const std::string req2 = plain_http_request("GET", config.resource_prefix + hash_b);
  const std::ptrdiff_t sent = grc::rs::socket_send(fd, req2.data(), req2.size());
  check(sent == static_cast<std::ptrdiff_t>(req2.size()), "second request sent on the same (still-open) connection");
  const HttpResponse resp2 = read_http_response(fd);
  check(resp2.ok && resp2.status == 200 && resp2.body == pattern_bytes(48, 2),
        "second request on the same connection, keep-alive");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_http_connection_close_honoured() {
  FakeResourceSource source;
  const std::string hash = make_hash('8');
  source.set(hash, pattern_bytes(16, 3));
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);

  const SocketHandle fd = connect_loopback(server.port());
  const std::string req = plain_http_request("GET", config.resource_prefix + hash, {{"Connection", "close"}});
  grc::rs::socket_send(fd, req.data(), req.size());
  const HttpResponse resp = read_http_response(fd);
  check(resp.ok && resp.status == 200, "200 despite Connection: close");
  check(resp.headers.count("connection") != 0 && resp.headers.at("connection") == "close",
        "response echoes Connection: close");
  std::uint8_t probe;
  check(grc::rs::socket_recv(fd, &probe, 1) == 0, "Connection: close actually closes the TCP connection");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_http_max_http_clients_503() {
  FakeResourceSource source;
  const std::string hash = make_hash('9');
  source.set(hash, pattern_bytes(8, 4));
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.max_http_clients = 2;
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);

  SocketHandle fds[3];
  for (int i = 0; i < 3; ++i) {
    fds[i] = connect_loopback(server.port());
    const std::string req = plain_http_request("GET", config.resource_prefix + hash);
    grc::rs::socket_send(fds[i], req.data(), req.size());
    const HttpResponse resp = read_http_response(fds[i]);
    if (i < 2) {
      check(resp.ok && resp.status == 200, "client " + std::to_string(i) + " within max_http_clients -> 200");
    } else {
      check(resp.ok && resp.status == 503,
            "client " + std::to_string(i) + " beyond max_http_clients -> 503, got " + std::to_string(resp.status));
    }
  }
  const auto events = wait_events(server, 3, 2000);
  check(events.size() == 3 && events.back().kind == grc::live::Event::HttpGet &&
            events.back().hash == hash && events.back().http_status == 503,
        "the client beyond max_http_clients is also reported as an HttpGet 503 event");
  for (SocketHandle fd : fds) grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_http_coexists_with_websocket() {
  FakeResourceSource source;
  const std::string hash = make_hash('a');
  source.set(hash, pattern_bytes(128, 5));
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);

  const SocketHandle ws_fd = connect_loopback(server.port());
  do_handshake(ws_fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "WebSocket session opened before any HTTP traffic");

  const SocketHandle http_fd = connect_loopback(server.port());
  const std::string req = plain_http_request("GET", config.resource_prefix + hash);
  grc::rs::socket_send(http_fd, req.data(), req.size());
  const HttpResponse resp = read_http_response(http_fd);
  check(resp.ok && resp.status == 200 && resp.body == pattern_bytes(128, 5),
        "HTTP GET succeeds alongside an open WebSocket session");
  grc::rs::socket_close(http_fd);

  // The successful GET above already pushed its own HttpGet event; drain and check it before
  // sending on the WebSocket, so the Text event below isn't waiting behind it in the queue.
  const auto http_events = wait_events(server, 1, 2000);
  check(!http_events.empty() && http_events[0].kind == grc::live::Event::HttpGet &&
            http_events[0].hash == hash && http_events[0].http_status == 200 && http_events[0].bytes == 128,
        "the HTTP GET is also reported as an HttpGet event");

  const auto frame = client_text("still alive");
  grc::rs::socket_send(ws_fd, frame.data(), frame.size());
  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events[0].kind == grc::live::Event::Text && events[0].text == "still alive",
        "the WebSocket session still carries data after a concurrent HTTP fetch");
  grc::rs::socket_close(ws_fd);
  server.stop(1000);
}

// --- Bearer-token authorization. ---

void test_constant_time_equals() {
  using grc::live::constant_time_equals;
  check(constant_time_equals("", ""), "constant_time_equals: empty vs empty");
  check(constant_time_equals("abc", "abc"), "constant_time_equals: equal strings");
  check(!constant_time_equals("abc", "abd"), "constant_time_equals: differ in the last byte");
  check(!constant_time_equals("abc", "ab"), "constant_time_equals: a longer than b");
  check(!constant_time_equals("ab", "abc"), "constant_time_equals: a shorter than b");
  check(!constant_time_equals("", "a"), "constant_time_equals: empty vs non-empty");
  check(!constant_time_equals("secret-token", "wrong-token"), "constant_time_equals: unrelated strings");
}

void test_ws_auth_missing_token_401() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.auth_token = "s3cr3t-token";
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");  // no Authorization header
  check(hs.status == 401, "missing bearer token -> 401, got " + std::to_string(hs.status));
  const auto events = wait_events(server, 1, 2000);
  check(events.size() == 1 && events[0].kind == grc::live::Event::AuthRejected,
        "a rejected upgrade pushes exactly one AuthRejected event");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_ws_auth_wrong_token_401() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.auth_token = "s3cr3t-token";
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.1",
                                     {{"Authorization", "Bearer wrong-token"}});
  check(hs.status == 401, "wrong bearer token -> 401, got " + std::to_string(hs.status));
  check(wait_events(server, 1, 2000).size() == 1, "wrong token also pushes exactly one event");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_ws_auth_correct_token_101() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.auth_token = "s3cr3t-token";
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.1",
                                     {{"Authorization", "Bearer s3cr3t-token"}});
  check(hs.status == 101, "correct bearer token -> 101, got " + std::to_string(hs.status));
  check(expect_opened(server) != 0, "Opened event after a correctly authorized handshake");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_ws_auth_disabled_by_default() {
  // ServerConfig::auth_token defaults to empty: every handshake above this test already proves
  // this, but a dedicated check makes the default explicit for G2e.
  grc::live::Server server;
  grc::live::ServerConfig config;
  check(config.auth_token.empty(), "ServerConfig::auth_token defaults to empty");
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");  // no Authorization header at all
  check(hs.status == 101, "no auth_token configured -> unauthenticated upgrade still succeeds");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_http_get_auth_missing_token_401() {
  FakeResourceSource source;
  const std::string hash = make_hash('b');
  source.set(hash, pattern_bytes(16, 11));
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.auth_token = "s3cr3t-token";
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const std::string req = plain_http_request("GET", config.resource_prefix + hash);
  grc::rs::socket_send(fd, req.data(), req.size());
  const HttpResponse resp = read_http_response(fd);
  check(resp.ok && resp.status == 401, "missing bearer token on GET -> 401, got " + std::to_string(resp.status));
  check(resp.body.empty(), "401 body is empty");
  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events[0].kind == grc::live::Event::HttpGet && events[0].hash == hash &&
            events[0].http_status == 401,
        "the 401 is also reported as an HttpGet event naming the attempted hash");
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_http_get_auth_wrong_token_401() {
  FakeResourceSource source;
  const std::string hash = make_hash('c');
  source.set(hash, pattern_bytes(16, 12));
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.auth_token = "s3cr3t-token";
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const std::string req =
      plain_http_request("GET", config.resource_prefix + hash, {{"Authorization", "Bearer wrong-token"}});
  grc::rs::socket_send(fd, req.data(), req.size());
  const HttpResponse resp = read_http_response(fd);
  check(resp.ok && resp.status == 401, "wrong bearer token on GET -> 401, got " + std::to_string(resp.status));
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_http_get_auth_correct_token_200() {
  FakeResourceSource source;
  const std::string hash = make_hash('d');
  source.set(hash, pattern_bytes(16, 13));
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.auth_token = "s3cr3t-token";
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);
  const SocketHandle fd = connect_loopback(server.port());
  const std::string req =
      plain_http_request("GET", config.resource_prefix + hash, {{"Authorization", "Bearer s3cr3t-token"}});
  grc::rs::socket_send(fd, req.data(), req.size());
  const HttpResponse resp = read_http_response(fd);
  check(resp.ok && resp.status == 200 && resp.body == pattern_bytes(16, 13),
        "correct bearer token on GET -> 200 byte-exact, got status " + std::to_string(resp.status));
  grc::rs::socket_close(fd);
  server.stop(1000);
}

void test_no_mmap_mprotect_imports() {
#ifdef _WIN32
  std::puts("skip no-mmap-mprotect-imports: ELF nm inspection; PE imports are checked by w-imports");
#else
  char exe_path[4096];
  const std::ptrdiff_t n = ::readlink("/proc/self/exe", exe_path, sizeof(exe_path) - 1);
  check(n > 0, "readlink /proc/self/exe");
  if (n <= 0) return;
  exe_path[n] = '\0';

  const std::string cmd = std::string("nm -D --undefined-only '") + exe_path + "' 2>/dev/null";
  FILE *pipe = ::popen(cmd.c_str(), "r");
  check(pipe != nullptr, "popen(nm) for the import check");
  if (pipe == nullptr) return;
  bool found_mmap = false;
  bool found_mprotect = false;
  char line[512];
  while (std::fgets(line, sizeof(line), pipe) != nullptr) {
    const std::string l(line);
    if (l.find("mmap") != std::string::npos) found_mmap = true;
    if (l.find("mprotect") != std::string::npos) found_mprotect = true;
  }
  ::pclose(pipe);
  check(!found_mmap, "the test binary imports no mmap symbol (HTTP bodies are served from memory, never mapped)");
  check(!found_mprotect, "the test binary imports no mprotect symbol");
#endif
}

// ---------------------------------------------------------------------------
// two subprotocols, the /7 upgrade without a bearer
// header, the Origin allowlist (403 on every route), CORS on GET, the preflight, and the
// no-cors / accept-any-origin sabotage switches.

const char *const kOrigin = "http://127.0.0.1:5173";
const char *const kForeign = "http://evil.example:80";

grc::live::ServerConfig g7n_config() {
  grc::live::ServerConfig config;
  config.subprotocols = {"render-stream.7", "render-stream.6"};
  config.hello_token_subprotocols = {"render-stream.7"};
  config.allowed_origins = {kOrigin};
  config.max_clients = 4;
  return config;
}

// Sends one request on a fresh connection and reads one response.
HttpResponse one_request(std::uint16_t port, const std::string &method, const std::string &path,
                         const std::vector<std::pair<std::string, std::string>> &headers) {
  const SocketHandle fd = connect_loopback(port);
  const std::string req = plain_http_request(method, path, headers);
  grc::rs::socket_send(fd, req.data(), req.size());
  HttpResponse resp = read_http_response(fd);
  grc::rs::socket_close(fd);
  return resp;
}

std::string header_or(const HttpResponse &r, const std::string &name) {
  const auto it = r.headers.find(name);
  return it == r.headers.end() ? std::string("<absent>") : it->second;
}

void test_g7n_subprotocol_choice() {
  grc::live::Server server;
  grc::live::ServerConfig config = g7n_config();
  config.auth_token = "s3cr3t-token";
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  struct Case {
    const char *offered;
    int status;
    const char *chosen;
  };
  const Case cases[] = {
      {"render-stream.6, render-stream.7", 101, "render-stream.7"},
      {"render-stream.7", 101, "render-stream.7"},
      {"render-stream.6", 401, ""},  // /6 keeps the bearer check on its upgrade
      {"render-stream.5", 400, ""},
  };
  for (const Case &k : cases) {
    const SocketHandle fd = connect_loopback(server.port());
    const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", k.offered);
    check(hs.status == k.status, std::string("offered '") + k.offered + "' -> " + std::to_string(k.status) +
                                     ", got " + std::to_string(hs.status));
    // The previous case's connection closing pushes a Closed event: drop those.
    std::vector<grc::live::Event> events;
    if (k.status != 400) {
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2000);
      while (events.empty() && std::chrono::steady_clock::now() < deadline) {
        for (auto &e : server.take_events()) {
          if (e.kind != grc::live::Event::Closed) events.push_back(std::move(e));
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
      }
    }
    if (k.status == 101) {
      check(hs.raw.find(std::string("Sec-WebSocket-Protocol: ") + k.chosen + "\r\n") != std::string::npos,
            std::string("offered '") + k.offered + "' echoes " + k.chosen);
      check(events.size() == 1 && events[0].kind == grc::live::Event::Opened &&
                events[0].subprotocol == k.chosen && events[0].origin.empty(),
            std::string("Opened reports subprotocol ") + k.chosen + " and no origin");
    } else if (k.status == 401) {
      check(events.size() == 1 && events[0].kind == grc::live::Event::AuthRejected,
            "the /6 401 is an AuthRejected event");
    }
    grc::rs::socket_close(fd);
  }
  {
    // /6 with the right bearer header still upgrades, and is reported as /6.
    const SocketHandle fd = connect_loopback(server.port());
    const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.6",
                                       {{"Authorization", "Bearer s3cr3t-token"}});
    check(hs.status == 101, "/6 with the right bearer header -> 101");
    bool reported = false;
    for (const auto &e : wait_events(server, 1, 2000)) {
      reported = reported || (e.kind == grc::live::Event::Opened && e.subprotocol == "render-stream.6");
    }
    check(reported, "reported as render-stream.6");
    grc::rs::socket_close(fd);
  }
  server.stop(1000);
}

void test_g7n_origin_on_upgrade() {
  grc::live::Server server;
  std::string error;
  check(server.start(g7n_config(), nullptr, &error), "server starts: " + error);
  {
    const SocketHandle fd = connect_loopback(server.port());
    const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7",
                                       {{"Origin", kForeign}});
    check(hs.status == 403, "a foreign Origin's upgrade -> 403, got " + std::to_string(hs.status));
    const auto events = wait_events(server, 1, 2000);
    check(events.size() == 1 && events[0].kind == grc::live::Event::OriginRejected &&
              events[0].origin == kForeign && events[0].route == "upgrade" && events[0].method == "GET" &&
              events[0].http_status == 403,
          "one OriginRejected event (route upgrade), no Opened");
    grc::rs::socket_close(fd);
  }
  {
    const SocketHandle fd = connect_loopback(server.port());
    const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7",
                                       {{"Origin", kOrigin}});
    check(hs.status == 101, "an allowed Origin's upgrade -> 101");
    check(hs.raw.find("Access-Control") == std::string::npos, "the 101 is unchanged (no CORS header)");
    const auto events = wait_events(server, 1, 2000);
    check(events.size() == 1 && events[0].kind == grc::live::Event::Opened && events[0].origin == kOrigin,
          "Opened carries the allowed origin");
    grc::rs::socket_close(fd);
  }
  {
    // Origin is compared exactly: a trailing slash or another port is foreign.
    for (const char *near_origin : {"http://127.0.0.1:5173/", "http://127.0.0.1:5174", "HTTP://127.0.0.1:5173", "null"}) {
      const SocketHandle fd = connect_loopback(server.port());
      const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7",
                                         {{"Origin", near_origin}});
      check(hs.status == 403, std::string("near-miss origin '") + near_origin + "' -> 403");
      wait_events(server, 1, 1000);
      grc::rs::socket_close(fd);
    }
  }
  server.stop(1000);
}

void test_g7n_origin_and_cors_on_resources() {
  FakeResourceSource source;
  const std::string hash = make_hash('7');
  source.set(hash, pattern_bytes(32, 9));
  grc::live::Server server;
  grc::live::ServerConfig config = g7n_config();
  config.auth_token = "s3cr3t-token";
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);
  const std::string path = config.resource_prefix + hash;
  const std::pair<std::string, std::string> bearer{"Authorization", "Bearer s3cr3t-token"};

  // No Origin: exactly /6 -- no CORS header, OPTIONS is 405.
  {
    const HttpResponse r = one_request(server.port(), "GET", path, {bearer});
    check(r.ok && r.status == 200 && r.headers.count("access-control-allow-origin") == 0 &&
              r.headers.count("vary") == 0,
          "GET without Origin: 200 and no CORS header");
    const HttpResponse o = one_request(server.port(), "OPTIONS", path, {});
    check(o.ok && o.status == 405, "OPTIONS without Origin: 405 as before");
    wait_events(server, 2, 2000);
  }
  // A foreign Origin: 403 on GET and OPTIONS, an OriginRejected event each, never HttpGet.
  for (const char *method : {"GET", "OPTIONS"}) {
    const HttpResponse r = one_request(server.port(), method, path, {bearer, {"Origin", kForeign}});
    check(r.ok && r.status == 403 && r.headers.count("access-control-allow-origin") == 0,
          std::string(method) + " from a foreign Origin -> 403 without CORS");
    const auto events = wait_events(server, 1, 2000);
    check(events.size() == 1 && events[0].kind == grc::live::Event::OriginRejected &&
              events[0].route == "resource" && events[0].method == method && events[0].hash == hash,
          std::string(method) + " 403 is one OriginRejected event (route resource)");
  }
  // An allowed Origin: GET 200 / 404 / 401 add ACAO + Vary.
  {
    const HttpResponse r = one_request(server.port(), "GET", path, {bearer, {"Origin", kOrigin}});
    check(r.ok && r.status == 200 && header_or(r, "access-control-allow-origin") == kOrigin &&
              header_or(r, "vary") == "Origin" && r.body == pattern_bytes(32, 9),
          "allowed GET: 200, ACAO <origin>, Vary: Origin, body intact");
    const HttpResponse missing =
        one_request(server.port(), "GET", config.resource_prefix + make_hash('8'), {bearer, {"Origin", kOrigin}});
    check(missing.ok && missing.status == 404 && header_or(missing, "access-control-allow-origin") == kOrigin,
          "allowed GET of an unknown hash: 404 a page can read (ACAO present)");
    const HttpResponse unauth = one_request(server.port(), "GET", path, {{"Origin", kOrigin}});
    check(unauth.ok && unauth.status == 401 && header_or(unauth, "access-control-allow-origin") == kOrigin,
          "allowed GET without the bearer header: 401 with ACAO");
    const auto events = wait_events(server, 3, 2000);
    check(events.size() == 3 && events[0].kind == grc::live::Event::HttpGet && events[0].method == "GET" &&
              events[0].origin == kOrigin && events[0].http_status == 200,
          "allowed GETs are HttpGet events with method GET and the origin");
  }
  // An allowed Origin's preflight: 204 with exactly the preflight headers, for any hash, with no
  // bearer header, and no Content-Length (RFC 9110 8.6).
  for (const std::string &target : {path, config.resource_prefix + make_hash('8'), config.resource_prefix + "nothex"}) {
    const HttpResponse r = one_request(server.port(), "OPTIONS", target,
                                       {{"Origin", kOrigin},
                                        {"Access-Control-Request-Method", "GET"},
                                        {"Access-Control-Request-Headers", "authorization"}});
    std::map<std::string, std::string> expected = {
        {"access-control-allow-origin", kOrigin}, {"access-control-allow-methods", "GET"},
        {"access-control-allow-headers", "authorization"}, {"access-control-max-age", "7200"},
        {"vary", "Origin"}, {"connection", "keep-alive"}};
    check(r.ok && r.status == 204 && r.headers == expected,
          "preflight of " + target.substr(target.size() - 6) + ": 204 with exactly the preflight headers");
    const auto events = wait_events(server, 1, 2000);
    check(events.size() == 1 && events[0].kind == grc::live::Event::HttpGet && events[0].method == "OPTIONS" &&
              events[0].http_status == 204,
          "a preflight is an HttpGet event with method OPTIONS, status 204");
  }
  server.stop(1000);
}

void test_g7n_sabotage_switches() {
  FakeResourceSource source;
  const std::string hash = make_hash('9');
  source.set(hash, pattern_bytes(8, 1));
  {
    // accept-any-origin: the allowlist is ignored; a foreign origin is answered as allowed.
    grc::live::Server server;
    grc::live::ServerConfig config = g7n_config();
    config.enforce_origins = false;
    std::string error;
    check(server.start(config, &source, &error), "server starts: " + error);
    const HttpResponse r = one_request(server.port(), "GET", config.resource_prefix + hash, {{"Origin", kForeign}});
    check(r.ok && r.status == 200 && header_or(r, "access-control-allow-origin") == kForeign,
          "accept-any-origin: a foreign GET is 200 with ACAO <foreign>");
    const SocketHandle fd = connect_loopback(server.port());
    const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7",
                                       {{"Origin", kForeign}});
    check(hs.status == 101, "accept-any-origin: a foreign upgrade is 101");
    grc::rs::socket_close(fd);
    server.stop(1000);
  }
  {
    // no-cors: the allowlist still holds, but no Access-Control-* header is ever sent.
    grc::live::Server server;
    grc::live::ServerConfig config = g7n_config();
    config.cors_headers = false;
    std::string error;
    check(server.start(config, &source, &error), "server starts: " + error);
    const HttpResponse r = one_request(server.port(), "GET", config.resource_prefix + hash, {{"Origin", kOrigin}});
    check(r.ok && r.status == 200 && r.headers.count("access-control-allow-origin") == 0 &&
              header_or(r, "vary") == "Origin",
          "no-cors: an allowed GET is 200 without ACAO");
    const HttpResponse o = one_request(server.port(), "OPTIONS", config.resource_prefix + hash, {{"Origin", kOrigin}});
    bool any_acao = false;
    for (const auto &h : o.headers) any_acao = any_acao || h.first.rfind("access-control-", 0) == 0;
    check(o.ok && o.status == 204 && !any_acao, "no-cors: the preflight is 204 with no Access-Control-* header");
    const HttpResponse f = one_request(server.port(), "GET", config.resource_prefix + hash, {{"Origin", kForeign}});
    check(f.ok && f.status == 403, "no-cors: a foreign origin is still 403");
    server.stop(1000);
  }
}

void test_g7n_parse_allowed_origins() {
  std::vector<std::string> out;
  std::string error;
  check(grc::live::parse_allowed_origins("", &out, &error) && out.empty(), "empty -> empty list");
  check(grc::live::parse_allowed_origins("http://127.0.0.1:5173", &out, &error) && out.size() == 1 &&
            out[0] == "http://127.0.0.1:5173",
        "one origin");
  check(grc::live::parse_allowed_origins(" http://127.0.0.1:5173 , https://localhost:8443,http://[::1]:80", &out,
                                         &error) &&
            out.size() == 3 && out[1] == "https://localhost:8443" && out[2] == "http://[::1]:80",
        "a comma list, spaces trimmed, an IPv6 literal");
  // CAR8: portless origins, as a browser serializes a default-port Origin.
  check(grc::live::parse_allowed_origins("https://example.com, http://[::1],http://127.0.0.1", &out, &error) &&
            out.size() == 3 && out[0] == "https://example.com" && out[1] == "http://[::1]" &&
            out[2] == "http://127.0.0.1",
        "portless origins accepted");
  for (const char *bad : {"https://example.com/", "https://example.com/x", "HTTPS://example.com",
                          "https://Example.com", "https://example.com:0", "http://", "http://:", "http://host:",
                          "http://[::1]x", "http://[::1]/", "http://a@b", "https://example.com?q", "https://exa mple.com",
                          "http://127.0.0.1:5173/", "http://127.0.0.1:5173/x",
                          "127.0.0.1:5173", "http://:5173", "HTTP://127.0.0.1:5173", "http://Host:1",
                          "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:05173",
                          "http://a@b:1", "http://127.0.0.1:5173,", "http://[::1:80", "*", "null",
                          "http://127.0.0.1:5173?q"}) {
    out = {"stale"};
    error.clear();
    check(!grc::live::parse_allowed_origins(bad, &out, &error) && out.empty() && !error.empty(),
          std::string("refused: '") + bad + "'");
  }
}

}  // namespace

// The first non-loopback IPv4 address of this machine, or "" (the LAN legs then skip).
std::string first_lan_ipv4() {
#ifdef _WIN32
  std::puts("skip LAN address discovery: getifaddrs is unavailable in the Windows test client");
  return "";
#else
  ifaddrs *list = nullptr;
  if (::getifaddrs(&list) != 0) return "";
  std::string found;
  for (ifaddrs *a = list; a != nullptr && found.empty(); a = a->ifa_next) {
    if (a->ifa_addr == nullptr || a->ifa_addr->sa_family != AF_INET || (a->ifa_flags & IFF_UP) == 0) continue;
    const auto *sin = reinterpret_cast<const sockaddr_in *>(a->ifa_addr);
    if ((ntohl(sin->sin_addr.s_addr) >> 24) == 127) continue;
    char buf[INET_ADDRSTRLEN];
    if (::inet_ntop(AF_INET, &sin->sin_addr, buf, sizeof(buf)) != nullptr) found = buf;
  }
  ::freeifaddrs(list);
  return found;
#endif
}

SocketHandle connect_ipv4(const std::string &host, std::uint16_t port) {
  grc::rs::IpAddress addr;
  if (!grc::rs::parse_ip_literal(host, grc::rs::AddrFamily::IPv4, &addr)) return kInvalidSocket;
  const auto fd = grc::rs::tcp_connect(addr, port, nullptr);
  if (fd != kInvalidSocket) client_timeouts(fd, false);
  return fd;
}

// CAR2 (D10): ServerConfig::allow_non_loopback is the one switch; without it nothing changes.
// ---- track subprotocols ----

const char *const kTrackSp = "render-stream-track.1";

// Waits for one event of `kind` (others are dropped); false on timeout.
bool wait_kind(grc::live::Server &server, grc::live::Event::Kind kind, grc::live::Event *out = nullptr) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2000);
  while (std::chrono::steady_clock::now() < deadline) {
    for (auto &e : server.take_events()) {
      if (e.kind == kind) {
        if (out != nullptr) *out = e;
        return true;
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  return false;
}

void test_trk1_track_upgrade_off() {
  grc::live::Server server;
  grc::live::ServerConfig config;  // default: no track_subprotocols
  check(config.track_subprotocols.empty() && config.max_tracks == 0, "trk1 off: defaults");
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const SocketHandle fd1 = connect_loopback(server.port());
  const Handshake track = do_handshake(fd1, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", kTrackSp);
  const SocketHandle fd2 = connect_loopback(server.port());
  const Handshake unknown = do_handshake(fd2, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "nope.1");
  check(track.ok && track.status == 400, "trk1 off: a track upgrade -> 400, got " + std::to_string(track.status));
  check(!track.raw.empty() && track.raw == unknown.raw,
        "trk1 off: the track upgrade's response is byte-identical to an unknown subprotocol's:\n" + track.raw +
            "\n---\n" + unknown.raw);
  check(wait_events(server, 1, 300).empty(), "trk1 off: no event for either");
  grc::rs::socket_close(fd1);
  grc::rs::socket_close(fd2);
  server.stop(1000);
}

void test_trk1_track_upgrade_on() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.track_subprotocols = {kTrackSp};
  config.max_tracks = 1;
  config.max_clients = 1;
  config.auth_token = "s3cr3t-token";
  const std::pair<std::string, std::string> bearer = {"Authorization", "Bearer s3cr3t-token"};
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);

  // A track upgrade without the bearer header: 101 with the track subprotocol.
  const SocketHandle t1 = connect_loopback(server.port());
  const Handshake hs1 = do_handshake(t1, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", kTrackSp);
  check(hs1.status == 101, "trk1 on: track upgrade without a token -> 101, got " + std::to_string(hs1.status));
  check(hs1.raw.find(std::string("Sec-WebSocket-Protocol: ") + kTrackSp + "\r\n") != std::string::npos,
        "trk1 on: echoes the track subprotocol");
  grc::live::Event opened;
  check(wait_kind(server, grc::live::Event::Opened, &opened) && opened.subprotocol == kTrackSp,
        "trk1 on: Opened reports the track subprotocol");

  // A view upgrade still needs the token.
  {
    const SocketHandle fd = connect_loopback(server.port());
    const Handshake hs = do_handshake(fd, "AAAAAAAAAAAAAAAAAAAAAA==");
    check(hs.status == 401, "trk1 on: view upgrade without the token -> 401, got " + std::to_string(hs.status));
    check(wait_kind(server, grc::live::Event::AuthRejected), "trk1 on: ...an AuthRejected event");
    grc::rs::socket_close(fd);
  }
  // A second track upgrade is over max_tracks.
  const SocketHandle t2 = connect_loopback(server.port());
  const Handshake hs2 = do_handshake(t2, "BBBBBBBBBBBBBBBBBBBBBA==", "/render-stream", kTrackSp);
  check(hs2.status == 503, "trk1 on: second track upgrade -> 503, got " + std::to_string(hs2.status));
  grc::rs::socket_close(t2);
  // ...while a view upgrade (with the token) still succeeds: the pools are independent.
  const SocketHandle v1 = connect_loopback(server.port());
  const Handshake hv = do_handshake(v1, "CCCCCCCCCCCCCCCCCCCCCA==", "/render-stream", "render-stream.1", {bearer});
  check(hv.status == 101, "trk1 on: view upgrade beside a track -> 101, got " + std::to_string(hv.status));
  check(wait_kind(server, grc::live::Event::Opened, &opened) && opened.subprotocol == "render-stream.1",
        "trk1 on: the view Opened");
  // And with the view pool full, a view upgrade is 503 while the track stays.
  {
    const SocketHandle fd = connect_loopback(server.port());
    const Handshake hs = do_handshake(fd, "DDDDDDDDDDDDDDDDDDDDDA==", "/render-stream", "render-stream.1", {bearer});
    check(hs.status == 503, "trk1 on: second view upgrade -> 503, got " + std::to_string(hs.status));
    grc::rs::socket_close(fd);
  }
  grc::rs::socket_close(v1);
  check(wait_kind(server, grc::live::Event::Closed), "trk1 on: view Closed");

  // A client offering both gets the view subprotocol, in either offer order (and is bearer-checked).
  for (const char *offer : {"render-stream.1, render-stream-track.1", "render-stream-track.1, render-stream.1"}) {
    const SocketHandle fd = connect_loopback(server.port());
    const Handshake hs = do_handshake(fd, "EEEEEEEEEEEEEEEEEEEEEA==", "/render-stream", offer, {bearer});
    check(hs.status == 101 && hs.raw.find("Sec-WebSocket-Protocol: render-stream.1\r\n") != std::string::npos,
          std::string("trk1 on: offering '") + offer + "' gets the view subprotocol, got " + hs.raw);
    check(wait_kind(server, grc::live::Event::Opened, &opened) && opened.subprotocol == "render-stream.1",
          std::string("trk1 on: '") + offer + "' Opened as view");
    grc::rs::socket_close(fd);
    check(wait_kind(server, grc::live::Event::Closed), "trk1 on: closed between offers");
  }
  {
    // Offering both without a token: it is a view upgrade, so 401.
    const SocketHandle fd = connect_loopback(server.port());
    const Handshake hs = do_handshake(fd, "FFFFFFFFFFFFFFFFFFFFFA==", "/render-stream", "render-stream.1, render-stream-track.1");
    check(hs.status == 401, "trk1 on: both offered without the token -> 401, got " + std::to_string(hs.status));
    grc::rs::socket_close(fd);
  }
  // The track slot returns at its Closed.
  grc::rs::socket_close(t1);
  check(wait_kind(server, grc::live::Event::Closed), "trk1 on: track Closed");
  const SocketHandle t3 = connect_loopback(server.port());
  const Handshake hs3 = do_handshake(t3, "GGGGGGGGGGGGGGGGGGGGGA==", "/render-stream", kTrackSp);
  check(hs3.status == 101, "trk1 on: a track upgrade after the first closed -> 101, got " + std::to_string(hs3.status));
  grc::rs::socket_close(t3);
  server.stop(1000);
}

void test_lan_bind() {
  {
    grc::live::Server server;
    grc::live::ServerConfig config = g7n_config();
    config.host = "0.0.0.0";
    std::string error;
    check(!server.start(config, nullptr, &error) && error == "non-loopback",
          "0.0.0.0 without allow_non_loopback -> non-loopback");
  }
  for (const char *host : {"::", "::ffff:0:0", "not-an-ip", "example.com", "", "0.0.0.0:80", "[::]"}) {
    grc::live::Server server;
    grc::live::ServerConfig config = g7n_config();
    config.host = host;
    config.allow_non_loopback = true;
    std::string error;
    const bool started = server.start(config, nullptr, &error);
    const std::string h = host;
    if (h == "::" || h == "::ffff:0:0") {
      // IPv6 may be absent on a runner: a socket/bind failure is not a policy result.
      check(started || error.rfind("socket:", 0) == 0 || error.rfind("bind:", 0) == 0,
            "host '" + h + "' with allow_non_loopback binds or fails in the OS, got '" + error + "'");
    } else {
      check(!started && error == "non-loopback", "host '" + h + "' is not an IP literal -> non-loopback, got '" + error + "'");
    }
    if (started) server.stop(1000);
  }
  grc::live::Server server;
  grc::live::ServerConfig config = g7n_config();
  config.host = "0.0.0.0";
  config.allow_non_loopback = true;
  std::string error;
  check(server.start(config, nullptr, &error), "0.0.0.0 with allow_non_loopback starts: " + error);
  const std::string lan = first_lan_ipv4();
  std::vector<std::string> via = {"127.0.0.1"};
  if (!lan.empty()) via.push_back(lan);
  else std::printf("rs_ws_test: no non-loopback IPv4 address; the LAN-address connection is skipped\n");
  for (const std::string &host : via) {
    const SocketHandle fd = connect_ipv4(host, server.port());
    check(fd != kInvalidSocket, "connects to 0.0.0.0's listener through " + host);
    if (fd == kInvalidSocket) continue;
    const Handshake ok = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7",
                                       {{"Origin", kOrigin}});
    check(ok.status == 101, "an allowed Origin's upgrade through " + host + " -> 101, got " + std::to_string(ok.status));
    wait_events(server, 1, 2000);
    grc::rs::socket_close(fd);
    const SocketHandle fd2 = connect_ipv4(host, server.port());
    const Handshake bad = do_handshake(fd2, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7",
                                        {{"Origin", kForeign}});
    check(bad.status == 403, "a foreign Origin through " + host + " -> 403, got " + std::to_string(bad.status));
    wait_events(server, 1, 2000);
    grc::rs::socket_close(fd2);
    // The same listener also enforces the bearer token on resources and the upgrade rules.
    const SocketHandle fd3 = connect_ipv4(host, server.port());
    const Handshake nosub = do_handshake(fd3, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "", {{"Origin", kOrigin}});
    check(nosub.status == 400, "no subprotocol through " + host + " -> 400, got " + std::to_string(nosub.status));
    grc::rs::socket_close(fd3);
  }
  server.stop(1000);
  if (!lan.empty()) {
    // A listener bound to the host address itself.
    grc::live::Server bound;
    grc::live::ServerConfig c2 = g7n_config();
    c2.host = lan;
    c2.allow_non_loopback = true;
    check(bound.start(c2, nullptr, &error), "the host address binds with allow_non_loopback: " + error);
    const SocketHandle fd = connect_ipv4(lan, bound.port());
    check(fd != kInvalidSocket, "connects to " + lan);
    if (fd != kInvalidSocket) grc::rs::socket_close(fd);
    check(connect_loopback(bound.port()) == kInvalidSocket, "a listener bound to " + lan + " is not on 127.0.0.1");
    bound.stop(1000);
  }
}

// Reads until the peer closes or `ms` passes; the first frame, if any.
ServerFrame first_frame_or_close(SocketHandle fd) { return read_server_frame(fd); }

std::uint16_t close_code_of(const ServerFrame &f) {
  return f.ok && f.opcode == 0x8 && f.payload.size() >= 2
             ? static_cast<std::uint16_t>((static_cast<std::uint16_t>(f.payload[0]) << 8) | f.payload[1])
             : 0;
}

// Security: the parser the LAN can now reach. Each case gets its own
// connection; after all of them a fresh handshake still gets a 101.
void test_malformed_inputs_on_lan_listener() {
  grc::live::Server server;
  grc::live::ServerConfig config = g7n_config();
  config.host = "0.0.0.0";
  config.allow_non_loopback = true;
  std::string error;
  check(server.start(config, nullptr, &error), "malformed-input server starts: " + error);
  const auto upgraded = [&]() {
    const SocketHandle fd = connect_loopback(server.port());
    const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7",
                                       {{"Origin", kOrigin}});
    if (hs.status != 101) {
      grc::rs::socket_close(fd);
      return kInvalidSocket;
    }
    wait_events(server, 1, 2000);
    return fd;
  };
  // Headers over 8 KiB without a terminator, then with one.
  for (const bool terminated : {false, true}) {
    const SocketHandle fd = connect_loopback(server.port());
    std::string req = "GET /render-stream HTTP/1.1\r\nHost: x\r\nX-Pad: " + std::string(9000, 'a') + (terminated ? "\r\n\r\n" : "");
    grc::rs::socket_send(fd, req.data(), req.size());
    const auto bytes = recv_some(fd);
    const std::string raw(bytes.begin(), bytes.end());
    check(raw.rfind("HTTP/1.1 400", 0) == 0 || raw.rfind("HTTP/1.1 431", 0) == 0 || raw.empty(),
          std::string("headers over 8 KiB (") + (terminated ? "terminated" : "unterminated") + ") -> 400 or closed, got " + raw.substr(0, 40));
    grc::rs::socket_close(fd);
  }
  // A NUL in the request line, a lone LF head, an absurd method and a 70000-byte target.
  for (const std::string &req : {std::string("GET /render\0stream HTTP/1.1\r\n\r\n", 32), std::string("GET / HTTP/1.1\n\n"),
                                 std::string(300, 'M') + " / HTTP/1.1\r\n\r\n",
                                 "GET /" + std::string(70000, 'p') + " HTTP/1.1\r\n\r\n"}) {
    const SocketHandle fd = connect_loopback(server.port());
    grc::rs::socket_send(fd, req.data(), req.size());
    const auto bytes = recv_some(fd);
    const std::string raw(bytes.begin(), bytes.end());
    check(raw.empty() || raw.rfind("HTTP/1.1 4", 0) == 0, "a malformed head -> 4xx or closed, got " + raw.substr(0, 40));
    grc::rs::socket_close(fd);
  }
  // Frame headers: {description, bytes, expected close code (0: the server just closes)}.
  struct Case {
    const char *what;
    std::vector<std::uint8_t> bytes;
    std::uint16_t code;
  };
  const std::uint8_t k[4] = {1, 2, 3, 4};
  const auto with_key = [&](std::vector<std::uint8_t> v) {
    v.insert(v.end(), k, k + 4);
    return v;
  };
  const Case cases[] = {
      {"RSV1 set", with_key({0xC1, 0x80}), 1002},
      {"RSV2|RSV3 set", with_key({0xB1, 0x80}), 1002},
      {"unmasked frame", {0x81, 0x00}, 1002},
      {"64-bit length with the top bit set", with_key({0x81, 0xFF, 0x80, 0, 0, 0, 0, 0, 0, 0}), 1002},
      {"64-bit length 2^40 text", with_key({0x81, 0xFF, 0, 0, 1, 0, 0, 0, 0, 0}), 1009},
      {"16-bit length 65535 text", with_key({0x81, 0xFE, 0xFF, 0xFF}), 1009},
      {"ping with the 16-bit length form", with_key({0x89, 0xFE, 0x00, 0x7E}), 1002},
      {"close with the 64-bit length form", with_key({0x88, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0x7E}), 1002},
      {"fragmented control frame", with_key({0x09, 0x80}), 1002},
      {"reserved opcode 0x3", with_key({0x83, 0x80}), 1002},
      {"reserved opcode 0xB", with_key({0x8B, 0x80}), 1002},
      {"continuation without a start", with_key({0x80, 0x80}), 1002},
      {"binary frame", with_key({0x82, 0x80}), 1003},
  };
  for (const Case &c : cases) {
    const SocketHandle fd = upgraded();
    check(fd != kInvalidSocket, std::string("upgrade before: ") + c.what);
    if (fd == kInvalidSocket) continue;
    grc::rs::socket_send(fd, c.bytes.data(), c.bytes.size());
    const ServerFrame f = first_frame_or_close(fd);
    check(close_code_of(f) == c.code, std::string(c.what) + " closes " + std::to_string(c.code) + ", got " +
                                          std::to_string(close_code_of(f)));
    grc::rs::socket_close(fd);
  }
  {
    // A masked text frame whose payload is not UTF-8.
    const SocketHandle fd = upgraded();
    if (fd != kInvalidSocket) {
      const auto f = client_frame(0x1, {0xC3, 0x28, 0xFF});
      grc::rs::socket_send(fd, f.data(), f.size());
      const ServerFrame r = first_frame_or_close(fd);
      check(close_code_of(r) == 1007 || close_code_of(r) == 1002 || close_code_of(r) == 0,
            "non-UTF-8 text is closed or tolerated without a crash, got " + std::to_string(close_code_of(r)));
      grc::rs::socket_close(fd);
    }
  }
  {
    // A header cut off mid-way and an abrupt close; a frame header cut off and a close.
    const SocketHandle fd = connect_loopback(server.port());
    const std::string half = "GET /render-stream HTTP/1.1\r\nHost: x\r\nUpg";
    grc::rs::socket_send(fd, half.data(), half.size());
    grc::rs::socket_close(fd);
    const SocketHandle fd2 = upgraded();
    if (fd2 != kInvalidSocket) {
      const std::uint8_t part[3] = {0x81, 0xFE, 0x01};
      grc::rs::socket_send(fd2, part, sizeof(part));
      grc::rs::socket_close(fd2);
    }
    wait_events(server, 1, 500);
  }
  const SocketHandle after = upgraded();
  check(after != kInvalidSocket, "the server still upgrades after every malformed input");
  if (after != kInvalidSocket) grc::rs::socket_close(after);
  server.stop(1000);
}

// ---------------------------------------------------------------------------
// wss and https on the same port, through the real net
// module's TLS session (librender_stream_net.so beside this binary, or GRC_LIVE_NET_MODULE),
// with an OpenSSL client and a P-256 certificate generated here at test time (never committed).
// Without OpenSSL at build time or the module at run time these cases print `skip`; with
// --require-tls a skip is a failure (scripts/test/self-test-wss.ts).
// ---------------------------------------------------------------------------

bool g_require_tls = false;

void tls_skip(const std::string &why) {
  if (g_require_tls) {
    check(false, "wss cases required but skipped: " + why);
  } else {
    std::printf("rs_ws_test: skip the wss cases: %s\n", why.c_str());
  }
}

#ifdef GRC_TEST_OPENSSL

struct TestPki {
  std::string dir;
  std::string cert;       // self-signed leaf: CN and SAN localhost, SAN 127.0.0.1
  std::string key;        // its key (PKCS#8)
  std::string other_key;  // a key that is not the certificate's
  std::string empty;      // an empty file
  bool ok = false;
  ~TestPki() {
    for (const std::string &f : {cert, key, other_key, empty}) {
      if (!f.empty()) ::unlink(f.c_str());
    }
    if (!dir.empty()) ::rmdir(dir.c_str());
  }
};

bool write_pem_key(const std::string &path, EVP_PKEY *key) {
  FILE *f = std::fopen(path.c_str(), "w");
  if (f == nullptr) return false;
  const bool ok = PEM_write_PrivateKey(f, key, nullptr, nullptr, 0, nullptr, nullptr) == 1;
  std::fclose(f);
  return ok;
}

void make_pki(TestPki *p) {
  const char *tmp = std::getenv("TMPDIR");
  std::string templ = std::string(tmp != nullptr && *tmp != '\0' ? tmp : "/tmp") + "/rs-ws-test-tls-XXXXXX";
  std::vector<char> buf(templ.begin(), templ.end());
  buf.push_back('\0');
  if (::mkdtemp(buf.data()) == nullptr) return;
  p->dir = buf.data();
  p->cert = p->dir + "/cert.pem";
  p->key = p->dir + "/key.pem";
  p->other_key = p->dir + "/other-key.pem";
  p->empty = p->dir + "/empty.pem";
  EVP_PKEY *key = EVP_EC_gen("P-256");
  EVP_PKEY *other = EVP_EC_gen("P-256");
  X509 *x = X509_new();
  bool ok = key != nullptr && other != nullptr && x != nullptr;
  if (ok) {
    X509_set_version(x, 2);
    ASN1_INTEGER_set(X509_get_serialNumber(x), static_cast<long>(::getpid()) + 1);
    X509_gmtime_adj(X509_getm_notBefore(x), -3600);
    X509_gmtime_adj(X509_getm_notAfter(x), 2L * 24 * 3600);
    X509_set_pubkey(x, key);
    X509_NAME *name = X509_get_subject_name(x);
    X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC, reinterpret_cast<const unsigned char *>("localhost"), -1,
                               -1, 0);
    X509_set_issuer_name(x, name);
    X509V3_CTX ctx;
    X509V3_set_ctx_nodb(&ctx);
    X509V3_set_ctx(&ctx, x, x, nullptr, nullptr, 0);
    X509_EXTENSION *san = X509V3_EXT_conf_nid(nullptr, &ctx, NID_subject_alt_name, "DNS:localhost,IP:127.0.0.1");
    ok = san != nullptr && X509_add_ext(x, san, -1) == 1;
    X509_EXTENSION_free(san);
    ok = ok && X509_sign(x, key, EVP_sha256()) > 0;
  }
  if (ok) {
    FILE *f = std::fopen(p->cert.c_str(), "w");
    ok = f != nullptr && PEM_write_X509(f, x) == 1;
    if (f != nullptr) std::fclose(f);
    ok = ok && write_pem_key(p->key, key) && write_pem_key(p->other_key, other);
    FILE *e = std::fopen(p->empty.c_str(), "w");
    ok = ok && e != nullptr;
    if (e != nullptr) std::fclose(e);
  }
  X509_free(x);
  EVP_PKEY_free(key);
  EVP_PKEY_free(other);
  p->ok = ok;
}

// A blocking OpenSSL client over an already-connected socket (the socket's 5 s timeouts apply).
struct TlsClient {
  SocketHandle fd = kInvalidSocket;
  SSL_CTX *ctx = nullptr;
  SSL *ssl = nullptr;
  bool ok = false;
  std::string alpn;
  int version = 0;
  TlsClient() = default;
  TlsClient(const TlsClient &) = delete;
  TlsClient &operator=(const TlsClient &) = delete;
  ~TlsClient() {
    if (ssl != nullptr) SSL_free(ssl);
    if (ctx != nullptr) SSL_CTX_free(ctx);
    if (fd != kInvalidSocket) grc::rs::socket_close(fd);
  }
  bool send(const std::string &s) { return send(reinterpret_cast<const std::uint8_t *>(s.data()), s.size()); }
  bool send(const std::uint8_t *data, std::size_t len) {
    std::size_t off = 0;
    while (off < len) {
      const int n = SSL_write(ssl, data + off, static_cast<int>(std::min<std::size_t>(len - off, 1u << 20)));
      if (n <= 0) return false;
      off += static_cast<std::size_t>(n);
    }
    return true;
  }
  // >0 bytes; 0 on close_notify; -1 on any other end (error, EOF without close_notify, timeout).
  int recv(std::uint8_t *out, std::size_t cap) {
    const int n = SSL_read(ssl, out, static_cast<int>(cap));
    if (n > 0) return n;
    return SSL_get_error(ssl, n) == SSL_ERROR_ZERO_RETURN ? 0 : -1;
  }
  bool recv_exact(std::uint8_t *out, std::size_t len) {
    std::size_t have = 0;
    while (have < len) {
      const int n = recv(out + have, len - have);
      if (n <= 0) return false;
      have += static_cast<std::size_t>(n);
    }
    return true;
  }
};

std::unique_ptr<TlsClient> tls_connect(SocketHandle fd, const TestPki &pki) {
  auto c = std::make_unique<TlsClient>();
  c->fd = fd;
  if (fd == kInvalidSocket) return c;
  c->ctx = SSL_CTX_new(TLS_client_method());
  SSL_CTX_load_verify_locations(c->ctx, pki.cert.c_str(), nullptr);
  SSL_CTX_set_verify(c->ctx, SSL_VERIFY_PEER, nullptr);
  static const unsigned char kAlpn[] = "\x02h2\x08http/1.1";
  SSL_CTX_set_alpn_protos(c->ctx, kAlpn, sizeof(kAlpn) - 1);
  c->ssl = SSL_new(c->ctx);
  SSL_set_fd(c->ssl, fd);
  SSL_set_tlsext_host_name(c->ssl, "localhost");
  SSL_set1_host(c->ssl, "localhost");
  c->ok = SSL_connect(c->ssl) == 1 && SSL_get_verify_result(c->ssl) == X509_V_OK;
  if (c->ok) {
    const unsigned char *proto = nullptr;
    unsigned int len = 0;
    SSL_get0_alpn_selected(c->ssl, &proto, &len);
    if (proto != nullptr) c->alpn.assign(reinterpret_cast<const char *>(proto), len);
    c->version = SSL_version(c->ssl);
  }
  return c;
}

HttpResponse tls_read_http_response(TlsClient &c) {
  HttpResponse out;
  std::vector<std::uint8_t> buf;
  std::uint8_t chunk[65536];
  std::size_t header_end = std::string::npos;
  while (header_end == std::string::npos) {
    const int n = c.recv(chunk, sizeof chunk);
    if (n <= 0) return out;
    buf.insert(buf.end(), chunk, chunk + n);
    for (std::size_t i = 0; i + 4 <= buf.size(); ++i) {
      if (std::memcmp(&buf[i], "\r\n\r\n", 4) == 0) {
        header_end = i;
        break;
      }
    }
  }
  const std::string head(buf.begin(), buf.begin() + static_cast<std::ptrdiff_t>(header_end));
  out.body.assign(buf.begin() + static_cast<std::ptrdiff_t>(header_end + 4), buf.end());
  std::size_t pos = head.find("\r\n");
  if (head.rfind("HTTP/1.1 ", 0) == 0 && head.size() >= 12) out.status = std::atoi(head.substr(9, 3).c_str());
  while (pos != std::string::npos) {
    const std::size_t start = pos + 2;
    const std::size_t end = head.find("\r\n", start);
    const std::string line = head.substr(start, end == std::string::npos ? std::string::npos : end - start);
    const std::size_t colon = line.find(':');
    if (colon != std::string::npos) {
      std::string name = line.substr(0, colon);
      for (char &ch : name) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
      std::string value = line.substr(colon + 1);
      while (!value.empty() && value[0] == ' ') value.erase(0, 1);
      out.headers.emplace(name, value);
    }
    pos = end;
  }
  const auto cl = out.headers.find("content-length");
  const std::size_t want = cl == out.headers.end() ? 0 : static_cast<std::size_t>(std::strtoull(cl->second.c_str(), nullptr, 10));
  while (out.body.size() < want) {
    const int n = c.recv(chunk, sizeof chunk);
    if (n <= 0) return out;
    out.body.insert(out.body.end(), chunk, chunk + n);
  }
  out.ok = out.body.size() == want;
  return out;
}

ServerFrame tls_read_server_frame(TlsClient &c) {
  ServerFrame out;
  std::uint8_t head[2];
  if (!c.recv_exact(head, 2)) return out;
  out.fin = (head[0] & 0x80) != 0;
  out.opcode = head[0] & 0x0F;
  if ((head[1] & 0x80) != 0) return out;
  std::uint64_t len = head[1] & 0x7F;
  std::size_t header_len = 2;
  if (len == 126 || len == 127) {
    const std::size_t ext_len = len == 126 ? 2 : 8;
    std::uint8_t ext[8];
    if (!c.recv_exact(ext, ext_len)) return out;
    len = 0;
    for (std::size_t i = 0; i < ext_len; ++i) len = (len << 8) | ext[i];
    header_len += ext_len;
  }
  out.payload.resize(static_cast<std::size_t>(len));
  if (len > 0 && !c.recv_exact(out.payload.data(), out.payload.size())) return out;
  out.header_len = header_len;
  out.ok = true;
  return out;
}

const std::vector<std::pair<std::string, std::string>> kOriginHeader = {{"Origin", "http://127.0.0.1:5173"}};

// The module's TLS table and a context over the test pair, or null (the cases skip).
std::unique_ptr<grc::live::NetTlsContext> tls_context(const TestPki &pki) {
  std::string error;
  const grc_net_tls_table_v1 *t = grc::live::load_net_tls(std::getenv("GRC_LIVE_NET_MODULE"), &error);
  if (t == nullptr) {
    tls_skip(error);
    return nullptr;
  }
  auto ctx = grc::live::NetTlsContext::create(t, pki.cert, pki.key, &error);
  check(ctx != nullptr, "the test pair loads: " + error);
  if (ctx != nullptr) check(ctx->cert_sha256().size() == 64, "the context reports the leaf's SHA-256");
  return ctx;
}

void test_wss_bad_pair(const TestPki &pki) {
  std::string error;
  const grc_net_tls_table_v1 *t = grc::live::load_net_tls(std::getenv("GRC_LIVE_NET_MODULE"), &error);
  if (t == nullptr) return;
  const std::pair<std::string, std::string> cases[] = {
      {pki.cert, pki.other_key},           // the CAR4 sabotage row: key not matching cert
      {pki.cert, pki.dir + "/missing.pem"},
      {pki.dir + "/missing.pem", pki.key},
      {pki.empty, pki.key},
      {pki.cert, pki.empty},
      {pki.key, pki.cert},  // swapped
  };
  for (const auto &c : cases) {
    error.clear();
    auto ctx = grc::live::NetTlsContext::create(t, c.first, c.second, &error);
    check(ctx == nullptr, "a bad pair is refused: " + c.first + " / " + c.second);
    check(error.rfind("tls-config-invalid: ", 0) == 0, "a bad pair is tls-config-invalid (got " + error + ")");
  }
}

grc::live::ServerConfig wss_config(grc::live::TlsContext *ctx) {
  grc::live::ServerConfig config = g7n_config();
  config.tls = ctx;
  config.codings = {grc::live::Coding::Zstd, grc::live::Coding::Gzip};
  return config;
}

void test_wss_upgrade_frames_and_stop(const TestPki &pki, grc::live::TlsContext *ctx) {
  grc::live::Server server;
  std::string error;
  check(server.start(wss_config(ctx), nullptr, &error), "wss server starts: " + error);
  auto c = tls_connect(connect_loopback(server.port()), pki);
  check(c->ok, "the TLS handshake completes and the leaf verifies");
  if (!c->ok) {
    server.stop(0);
    return;
  }
  check(c->alpn == "http/1.1", "ALPN picks http/1.1 (got '" + c->alpn + "')");
  check(c->version == TLS1_3_VERSION, "TLS 1.3");
  check(c->send(http_request("dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7", kOriginHeader)),
        "upgrade request over TLS");
  const HttpResponse up = tls_read_http_response(*c);
  check(up.status == 101, "the upgrade over TLS gets 101 (got " + std::to_string(up.status) + ")");
  check(header_or(up, "sec-websocket-accept") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", "the accept key over TLS");
  const auto opened = wait_events(server, 1, 2000);
  check(!opened.empty() && opened[0].kind == grc::live::Event::Opened && opened[0].subprotocol == "render-stream.7",
        "Opened, render-stream.7");
  const std::uint32_t conn = opened.empty() ? 0 : opened[0].conn;
  const auto text = client_frame(0x1, std::vector<std::uint8_t>{'h', 'i', ' ', 't', 'l', 's'});
  check(c->send(text.data(), text.size()), "a masked text frame over TLS");
  const auto got = wait_events(server, 1, 2000);
  check(got.size() == 1 && got[0].kind == grc::live::Event::Text && got[0].text == "hi tls", "Text event over TLS");
  // 8 MiB, several times kTlsChunk: the chunked encrypt-as-the-socket-drains path.
  const std::vector<std::uint8_t> big = pattern_bytes(8u << 20, 7);
  check(server.send_binary(conn, big), "8 MiB send_binary");
  check(server.send_text(conn, "after"), "a text after it");
  const ServerFrame f1 = tls_read_server_frame(*c);
  check(f1.ok && f1.opcode == 0x2 && f1.header_len == 10 && f1.payload == big, "8 MiB arrives byte-exact over TLS");
  const ServerFrame f2 = tls_read_server_frame(*c);
  check(f2.ok && f2.opcode == 0x1 && std::string(f2.payload.begin(), f2.payload.end()) == "after", "then the text");
  const auto drained = wait_stats_until(
      server, conn, [](const grc::live::Server::ConnStats &s) { return s.queued_bytes == 0; }, 2000);
  check(drained.queued_bytes == 0 && drained.sent_messages == 2, "queued_bytes returns to 0 (ciphertext included)");
  const grc::live::Server::TlsStats ts = server.tls_stats();
  check(ts.tls_connections == 1 && ts.handshakes == 1 && ts.tls_failed == 0 && ts.plaintext_loopback == 0,
        "tls_stats: one TLS connection, one handshake");
  // stop(): close 1000 "shutdown", then close_notify, then the TCP close.
  std::thread stopper([&] { server.stop(2000); });
  const ServerFrame close = tls_read_server_frame(*c);
  check(close_code_of(close) == 1000, "stop() sends close 1000 over TLS");
  std::uint8_t tail[16];
  check(c->recv(tail, sizeof tail) == 0, "then close_notify (a clean TLS end, not a bare EOF)");
  stopper.join();
}

void test_wss_close_while_client_sends(const TestPki &pki, grc::live::TlsContext *ctx) {
  grc::live::Server server;
  std::string error;
  check(server.start(wss_config(ctx), nullptr, &error), "linger WSS server starts: " + error);
  auto c = tls_connect(connect_loopback(server.port()), pki);
  check(c->ok, "linger WSS TLS handshake");
  if (!c->ok) {
    server.stop(0);
    return;
  }
  check(c->send(http_request("dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7", kOriginHeader)),
        "linger WSS upgrade request");
  check(tls_read_http_response(*c).status == 101, "linger WSS upgrade");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "linger WSS opened");
  // OpenSSL's socket BIO uses write(), unlike the raw client's MSG_NOSIGNAL send().
  // Keep a reset observable as a failed check rather than terminating the test process.
  const auto previous_sigpipe = std::signal(SIGPIPE, SIG_IGN);
  std::atomic<bool> started{false};
  std::atomic<bool> closing{false};
  double trailing_ms = 0;
  int sent_after_close = 0;
  int first_send_error = 0;
  std::thread writer([&] {
    const auto frame = client_text(std::string(1024, 'x'));
    do {
      c->send(frame.data(), frame.size());
      started.store(true);
      pause_one_millisecond();
    } while (!closing.load());
    const auto trailing_start = std::chrono::steady_clock::now();
    for (int i = 0; i < 100; ++i) {
      errno = 0;
      if (c->send(frame.data(), frame.size())) {
        ++sent_after_close;
      } else if (first_send_error == 0) {
        first_send_error = errno;
      }
      pause_one_millisecond();
    }
    trailing_ms = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - trailing_start).count();
  });
  while (!started.load()) std::this_thread::yield();
  check(server.send_text(conn, "final text"), "linger WSS queues final text");
  server.close(conn, 1008, "track-rate");
  closing.store(true);
  writer.join();
  std::printf("linger WSS 100 trailing frames: %.3f ms (bound < 500 ms)\n", trailing_ms);
  check(trailing_ms < 500, "linger WSS trailing loop finishes within half the 1000 ms linger deadline, ms=" +
                               std::to_string(trailing_ms));
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  const ServerFrame text = tls_read_server_frame(*c);
  check(text.ok && text.opcode == 1 && std::string(text.payload.begin(), text.payload.end()) == "final text",
        "linger WSS receives complete final text");
  const ServerFrame close = tls_read_server_frame(*c);
  const std::vector<std::uint8_t> expected = {0x03, 0xf0, 't', 'r', 'a', 'c', 'k', '-', 'r', 'a', 't', 'e'};
  check(close.ok && close.opcode == 8 && close.payload == expected,
        "linger WSS receives complete close 1008 track-rate");
  std::uint8_t tail[16];
  errno = 0;
  const int end = c->recv(tail, sizeof tail);
  const int recv_error = errno;
  check(end == 0, "linger WSS receives close_notify, recv=" + std::to_string(end) +
                      " errno=" + std::to_string(recv_error) + " (" + std::strerror(recv_error) + ")");
  expect_clean_eof(c->fd, "linger WSS");
  check(sent_after_close == 100, "linger WSS accepts 100 trailing TLS records, sent=" +
                                    std::to_string(sent_after_close) + " first errno=" +
                                    std::to_string(first_send_error) + " (" + std::strerror(first_send_error) + ")");
  const auto events = server.take_events();
  check(closed_count(events, conn) == 1, "linger WSS exactly one Closed at flush");
  bool after_closed = false;
  for (const auto &e : events) {
    if (e.conn != conn) continue;
    if (e.kind == grc::live::Event::Closed) {
      after_closed = true;
      check(e.code == 1008 && e.reason == "track-rate", "linger WSS Closed retains code and reason");
    } else {
      check(!after_closed, "linger WSS no events after Closed");
    }
  }
  check(server.tls_stats().tls_failed == 0, "linger WSS trailing ciphertext causes no TLS failure");
  c.reset();
  std::signal(SIGPIPE, previous_sigpipe);
  const auto start = std::chrono::steady_clock::now();
  server.stop(1500);
  const double wall_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
  std::printf("linger WSS stop(1500): %.3f ms\n", wall_ms);
  check(wall_ms < 2000, "linger WSS stop bounded");
  check(closed_count(server.take_events(), conn) == 0, "linger WSS no duplicate Closed at peer FIN/stop");
}

void test_wss_resources(const TestPki &pki, grc::live::TlsContext *ctx) {
  CodedResourceSource source;
  const std::string a = make_hash('a');
  const std::string b = make_hash('b');
  source.set(a, compressible_bytes(300000));
  source.set(b, pattern_bytes(1u << 20, 3));
  grc::live::Server server;
  std::string error;
  check(server.start(wss_config(ctx), &source, &error), "wss resource server starts: " + error);
  auto c = tls_connect(connect_loopback(server.port()), pki);
  check(c->ok, "https handshake");
  if (!c->ok) {
    server.stop(0);
    return;
  }
  // Five requests on one keep-alive TLS connection.
  const std::string path_a = "/resources/sha256/" + a;
  const std::string path_b = "/resources/sha256/" + b;
  c->send(plain_http_request("GET", path_b));
  const HttpResponse r1 = tls_read_http_response(*c);
  check(r1.ok && r1.status == 200 && r1.body == *source.lookup(b), "https GET 200, 1 MiB byte-exact");
  check(header_or(r1, "etag") == "\"" + b + "\"", "https ETag");
  check(header_or(r1, "cache-control") == "private, max-age=31536000, immutable", "https Cache-Control");
  c->send(plain_http_request("GET", path_b, {{"If-None-Match", "\"" + b + "\""}}));
  const HttpResponse r2 = tls_read_http_response(*c);
  check(r2.ok && r2.status == 304 && r2.body.empty() && header_or(r2, "etag") == "\"" + b + "\"",
        "https If-None-Match -> 304, same ETag");
  c->send(plain_http_request("GET", path_a, {{"Accept-Encoding", "gzip, zstd"}}));
  const HttpResponse r3 = tls_read_http_response(*c);
  std::vector<std::uint8_t> plain;
  check(r3.ok && r3.status == 200 && header_or(r3, "content-encoding") == "zstd" &&
            grc::rs::http_coding::zstd_decompress(r3.body.data(), r3.body.size(), &plain) &&
            plain == *source.lookup(a),
        "https zstd body decodes to the identity bytes");
  check(header_or(r3, "etag") == "\"" + a + "-zstd\"", "https coded ETag");
  check(header_or(r3, "vary").find("Accept-Encoding") != std::string::npos, "https Vary: Accept-Encoding");
  c->send(plain_http_request("GET", path_a, {{"Accept-Encoding", "gzip"}}));
  const HttpResponse r4 = tls_read_http_response(*c);
  plain.clear();
  check(r4.ok && r4.status == 200 && header_or(r4, "content-encoding") == "gzip" &&
            grc::rs::http_coding::gzip_decompress(r4.body.data(), r4.body.size(), &plain) &&
            plain == *source.lookup(a),
        "https gzip body decodes to the identity bytes");
  c->send(plain_http_request("GET", path_a, {{"Accept-Encoding", "zstd"}, {"If-None-Match", "\"" + a + "-zstd\""}}));
  const HttpResponse r5 = tls_read_http_response(*c);
  check(r5.ok && r5.status == 304 && r5.body.empty(), "https coded If-None-Match -> 304");
  const auto events = wait_events(server, 5, 2000);
  std::string statuses;
  for (const auto &e : events) {
    if (e.kind == grc::live::Event::HttpGet) statuses += std::to_string(e.http_status) + " ";
  }
  check(statuses == "200 304 200 200 304 ", "HttpGet events over https: " + statuses);
  check(events.size() >= 3 && events[2].coding == "zstd" && events[2].coded_bytes == r3.body.size(),
        "the coded GET reports its coding and wire bytes");
  // Plaintext from loopback, same port: still served (D12).
  const HttpResponse plain_get = one_request(server.port(), "GET", path_b, {});
  check(plain_get.ok && plain_get.status == 200 && plain_get.body == *source.lookup(b),
        "plaintext GET from loopback on the TLS port: 200");
  const SocketHandle fd = connect_loopback(server.port());
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7", kOriginHeader);
  check(hs.status == 101, "plaintext upgrade from loopback on the TLS port: 101");
  grc::rs::socket_close(fd);
  const grc::live::Server::TlsStats ts = server.tls_stats();
  check(ts.tls_connections == 1 && ts.plaintext_loopback == 2 && ts.tls_required == 0,
        "tls_stats: 1 TLS, 2 plaintext loopback (" + std::to_string(ts.tls_connections) + ", " +
            std::to_string(ts.plaintext_loopback) + ")");
  server.stop(1000);
}

void test_wss_tls_required_off_loopback(const TestPki &pki, grc::live::TlsContext *ctx) {
  const std::string lan = first_lan_ipv4();
  if (lan.empty()) {
    std::printf("rs_ws_test: unavailable: no non-loopback IPv4 address; the tls-required case is skipped\n");
    return;
  }
  FakeResourceSource source;
  const std::string b = make_hash('b');
  source.set(b, pattern_bytes(4096, 9));
  grc::live::ServerConfig config = wss_config(ctx);
  config.host = "0.0.0.0";
  config.allow_non_loopback = true;
  grc::live::Server server;
  std::string error;
  check(server.start(config, &source, &error), "wss on 0.0.0.0 starts: " + error);
  // Plaintext GET and upgrade through the LAN address: 403 "tls-required", then the TCP close.
  for (const std::string &req :
       {plain_http_request("GET", "/resources/sha256/" + b),
        http_request("dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7", kOriginHeader)}) {
    const SocketHandle fd = connect_ipv4(lan, server.port());
    grc::rs::socket_send(fd, req.data(), req.size());
    const HttpResponse r = read_http_response(fd);
    check(r.ok && r.status == 403 && std::string(r.body.begin(), r.body.end()) == "tls-required\n",
          "plaintext from " + lan + " is 403 tls-required (got " + std::to_string(r.status) + ")");
    std::uint8_t tail[8];
    check(grc::rs::socket_recv(fd, tail, sizeof tail) == 0, "and the TCP connection closes");
    grc::rs::socket_close(fd);
  }
  check(wait_events(server, 1, 200).empty(), "a tls-required refusal raises no event");
  // TLS through the LAN address: served.
  auto c = tls_connect(connect_ipv4(lan, server.port()), pki);
  check(c->ok, "TLS through " + lan + " handshakes");
  if (c->ok) {
    c->send(plain_http_request("GET", "/resources/sha256/" + b));
    const HttpResponse r = tls_read_http_response(*c);
    check(r.ok && r.status == 200 && r.body == *source.lookup(b), "https GET through the LAN address: 200");
  }
  // Plaintext from loopback on the same 0.0.0.0 listener: still served.
  const HttpResponse lo = one_request(server.port(), "GET", "/resources/sha256/" + b, {});
  check(lo.ok && lo.status == 200, "plaintext from loopback on the 0.0.0.0 listener: 200");
  const grc::live::Server::TlsStats ts = server.tls_stats();
  check(ts.tls_required == 2 && ts.tls_connections == 1 && ts.plaintext_loopback == 1 && ts.plaintext_lan == 0,
        "tls_stats: 2 tls-required, 1 TLS, 1 plaintext loopback, 0 plaintext LAN");
  server.stop(1000);
}

// D12, GRC_LIVE_LAN_PLAINTEXT=allow: with ServerConfig::lan_plaintext the same listener serves
// plaintext through the LAN address too (a plain-http LAN page's ws and GETs), TLS unchanged.
void test_wss_lan_plaintext(const TestPki &pki, grc::live::TlsContext *ctx) {
  const std::string lan = first_lan_ipv4();
  if (lan.empty()) {
    std::printf("rs_ws_test: unavailable: no non-loopback IPv4 address; the lan-plaintext case is skipped\n");
    return;
  }
  FakeResourceSource source;
  const std::string b = make_hash('b');
  source.set(b, pattern_bytes(4096, 9));
  grc::live::ServerConfig config = wss_config(ctx);
  config.host = "0.0.0.0";
  config.allow_non_loopback = true;
  config.lan_plaintext = true;
  grc::live::Server server;
  std::string error;
  check(server.start(config, &source, &error), "wss with lan_plaintext on 0.0.0.0 starts: " + error);
  // Plaintext GET through the LAN address: 200, byte-exact.
  {
    const SocketHandle fd = connect_ipv4(lan, server.port());
    const std::string req = plain_http_request("GET", "/resources/sha256/" + b);
    grc::rs::socket_send(fd, req.data(), req.size());
    const HttpResponse r = read_http_response(fd);
    check(r.ok && r.status == 200 && r.body == *source.lookup(b),
          "lan_plaintext: plaintext GET from " + lan + " is 200 (got " + std::to_string(r.status) + ")");
    grc::rs::socket_close(fd);
  }
  // Plaintext upgrade through the LAN address: 101, an Opened event, text in.
  {
    const SocketHandle fd = connect_ipv4(lan, server.port());
    const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7", kOriginHeader);
    check(hs.status == 101, "lan_plaintext: plaintext upgrade from " + lan + " is 101 (got " +
                                std::to_string(hs.status) + ")");
    const auto frame = client_text("hello");
    grc::rs::socket_send(fd, frame.data(), frame.size());
    const auto events = wait_events(server, 3, 2000);  // the GET's HttpGet, Opened, Text
    bool opened = false;
    bool text = false;
    for (const auto &e : events) {
      opened |= e.kind == grc::live::Event::Opened;
      text |= e.kind == grc::live::Event::Text && e.text == "hello";
    }
    check(opened && text, "lan_plaintext: the plaintext LAN session opens and its text arrives");
    grc::rs::socket_close(fd);
  }
  // TLS through the LAN address: still served.
  auto c = tls_connect(connect_ipv4(lan, server.port()), pki);
  check(c->ok, "lan_plaintext: TLS through " + lan + " handshakes");
  if (c->ok) {
    c->send(plain_http_request("GET", "/resources/sha256/" + b));
    const HttpResponse r = tls_read_http_response(*c);
    check(r.ok && r.status == 200 && r.body == *source.lookup(b), "lan_plaintext: https GET through the LAN address: 200");
  }
  const HttpResponse lo = one_request(server.port(), "GET", "/resources/sha256/" + b, {});
  check(lo.ok && lo.status == 200, "lan_plaintext: plaintext from loopback: 200");
  const grc::live::Server::TlsStats ts = server.tls_stats();
  check(ts.plaintext_lan == 2 && ts.tls_required == 0 && ts.tls_connections == 1 && ts.plaintext_loopback == 1,
        "lan_plaintext tls_stats: 2 plaintext LAN, 0 tls-required, 1 TLS, 1 plaintext loopback (" +
            std::to_string(ts.plaintext_lan) + ", " + std::to_string(ts.tls_required) + ", " +
            std::to_string(ts.tls_connections) + ", " + std::to_string(ts.plaintext_loopback) + ")");
  server.stop(1000);
}

void test_wss_bad_records(const TestPki &pki, grc::live::TlsContext *ctx) {
  grc::live::Server server;
  std::string error;
  check(server.start(wss_config(ctx), nullptr, &error), "wss server starts: " + error);
  {
    // A handshake record that is not a ClientHello: an alert, then the close.
    const SocketHandle fd = connect_loopback(server.port());
    // One record holding a ClientHello whose body is one byte: a decode error, not a wait.
    const std::uint8_t junk[] = {0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0xff};
    grc::rs::socket_send(fd, junk, sizeof junk);
    std::vector<std::uint8_t> got;
    std::uint8_t buf[256];
    for (;;) {
      const std::ptrdiff_t n = grc::rs::socket_recv(fd, buf, sizeof buf);
      if (n <= 0) break;
      got.insert(got.end(), buf, buf + n);
    }
    check(!got.empty() && got[0] == 0x15, "a bad ClientHello gets a TLS alert record, then the close");
    grc::rs::socket_close(fd);
  }
  {
    // A session that opened a WebSocket, then sends a forged application-data record: the
    // session fails, the hub sees Closed 1006 "tls error".
    auto c = tls_connect(connect_loopback(server.port()), pki);
    check(c->ok, "handshake");
    c->send(http_request("dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7", kOriginHeader));
    check(tls_read_http_response(*c).status == 101, "upgrade");
    const std::uint32_t conn = expect_opened(server);
    check(conn != 0, "opened");
    std::uint8_t forged[5 + 32] = {0x17, 0x03, 0x03, 0x00, 0x20};
    for (std::size_t i = 5; i < sizeof forged; ++i) forged[i] = static_cast<std::uint8_t>(i);
    grc::rs::socket_send(c->fd, forged, sizeof forged);
    const auto events = wait_events(server, 1, 2000);
    check(events.size() == 1 && events[0].kind == grc::live::Event::Closed && events[0].code == 1006 &&
              events[0].reason == "tls error",
          "a forged record closes the session: Closed 1006 tls error");
  }
  const grc::live::Server::TlsStats ts = server.tls_stats();
  check(ts.tls_connections == 2 && ts.tls_failed == 2, "tls_stats: both sessions failed");
  // The server goes on serving.
  auto c = tls_connect(connect_loopback(server.port()), pki);
  check(c->ok, "a fresh handshake after the failures");
  server.stop(1000);
}

// Not a check: handshake time and send throughput, TLS against plaintext on one server
// (--tls-bench; the numbers came from it).
void tls_bench(const TestPki &pki, grc::live::TlsContext *ctx) {
  grc::live::Server server;
  std::string error;
  if (!server.start(wss_config(ctx), nullptr, &error)) return;
  const auto now = [] { return std::chrono::steady_clock::now(); };
  const int handshakes = 200;
  auto t0 = now();
  for (int i = 0; i < handshakes; ++i) {
    auto c = tls_connect(connect_loopback(server.port()), pki);
    if (!c->ok) {
      std::printf("tls-bench: handshake %d failed\n", i);
      return;
    }
  }
  const double hs_ms = std::chrono::duration<double, std::milli>(now() - t0).count() / handshakes;
  std::printf("tls-bench: connect+handshake %.3f ms (mean of %d, client and server on one machine)\n", hs_ms,
              handshakes);
  for (const std::size_t size : {std::size_t{1024}, std::size_t{64u << 10}, std::size_t{1u << 20}}) {
    const int count = static_cast<int>(std::max<std::size_t>(64, (256u << 20) / size / 4));
    double secs[2] = {1e30, 1e30};  // the best of 5 alternating rounds each
    for (int round = 0; round < 10; ++round) {
      const int tls = round % 2;
      std::unique_ptr<TlsClient> c;
      SocketHandle fd = connect_loopback(server.port());
      if (tls == 1) {
        c = tls_connect(fd, pki);
        c->send(http_request("dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7", kOriginHeader));
        tls_read_http_response(*c);
      } else {
        do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", "render-stream.7", kOriginHeader);
      }
      const std::uint32_t conn = expect_opened(server);
      const std::vector<std::uint8_t> msg = pattern_bytes(size, 1);
      t0 = now();
      for (int i = 0; i < count; ++i) {
        server.send_binary(conn, msg);
        const ServerFrame f = tls == 1 ? tls_read_server_frame(*c) : read_server_frame(fd);
        if (!f.ok) {
          std::printf("tls-bench: frame %d failed\n", i);
          return;
        }
      }
      secs[tls] = std::min(secs[tls], std::chrono::duration<double>(now() - t0).count());
      if (tls == 0) grc::rs::socket_close(fd);
      server.close(conn, 1000, "");
      wait_events(server, 1, 1000);
    }
    std::printf("tls-bench: %zu-byte messages x %d, send->received round: plain %.2f us, tls %.2f us (+%.2f us, "
                "x%.2f)\n",
                size, count, secs[0] / count * 1e6, secs[1] / count * 1e6, (secs[1] - secs[0]) / count * 1e6,
                secs[1] / secs[0]);
  }
  server.stop(0);
}

#endif  // GRC_TEST_OPENSSL

void test_wss(bool bench) {
#ifdef GRC_TEST_OPENSSL
  TestPki pki;
  make_pki(&pki);
  check(pki.ok, "the test certificate is generated");
  if (!pki.ok) return;
  std::unique_ptr<grc::live::NetTlsContext> ctx = tls_context(pki);
  if (ctx == nullptr) return;
  if (bench) {
    tls_bench(pki, ctx.get());
    return;
  }
  test_wss_bad_pair(pki);
  test_wss_upgrade_frames_and_stop(pki, ctx.get());
  test_wss_close_while_client_sends(pki, ctx.get());
  test_wss_resources(pki, ctx.get());
  test_wss_tls_required_off_loopback(pki, ctx.get());
  test_wss_lan_plaintext(pki, ctx.get());
  test_wss_bad_records(pki, ctx.get());
#else
  (void)bench;
  tls_skip("built without OpenSSL (the test client)");
#endif
}

int main(int argc, char **argv) {
  bool linger_only = false;
  bool tls_only = false;
  bool tls_bench_only = false;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--linger-only") linger_only = true;
    if (arg == "--require-tls") g_require_tls = true;
    if (arg == "--tls-only") tls_only = true;
    if (arg == "--tls-bench") tls_bench_only = true;
  }
  if (linger_only) {
    test_linger();
    std::printf("rs_ws_test linger: %d/%d checks passed, %d failed\n", g_checks - g_failures, g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
  }
  if (tls_bench_only) {
    test_wss(true);
    return g_failures == 0 ? 0 : 1;
  }
  if (tls_only) {
    test_wss(false);
    if (g_failures != 0) {
      std::fprintf(stderr, "rs_ws_test: %d of %d checks failed\n", g_failures, g_checks);
      return 1;
    }
    std::printf("rs_ws_test: all %d wss checks passed\n", g_checks);
    return 0;
  }
  test_sha1_vectors();
  test_handshake_accept_key_rfc_vector();
  test_masked_text_roundtrip();
  test_frame_header_length_classes();
  test_ping_pong();
  test_close_handshake();
  test_linger();
  test_fragmentation_rejected();
  test_binary_inbound_rejected();
  test_unmasked_inbound_rejected();
  test_text_too_long();
  test_wrong_path_404();
  test_missing_subprotocol_400();
  test_malformed_request_400();
  test_max_clients_503();
  test_non_loopback_refused();
  test_queued_bytes_safety_net();
  test_stats_track_sent_bytes();
  test_large_binary_4mib();
  test_stop_closes_open_connections();
  test_http_get_sizes_byte_exact();
  test_http_404_unknown_hash();
  test_http_400_malformed_hash();
  test_http_405_wrong_method();
  test_http_if_none_match_304();
  test_negotiate_coding();
  test_http_content_coding();
  test_http_gzip_and_off_and_sabotage();
  test_http_keep_alive_two_requests_one_connection();
  test_http_connection_close_honoured();
  test_http_max_http_clients_503();
  test_http_coexists_with_websocket();
  test_constant_time_equals();
  test_ws_auth_missing_token_401();
  test_ws_auth_wrong_token_401();
  test_ws_auth_correct_token_101();
  test_ws_auth_disabled_by_default();
  test_http_get_auth_missing_token_401();
  test_http_get_auth_wrong_token_401();
  test_http_get_auth_correct_token_200();
  test_no_mmap_mprotect_imports();
  test_g7n_subprotocol_choice();
  test_g7n_origin_on_upgrade();
  test_g7n_origin_and_cors_on_resources();
  test_g7n_sabotage_switches();
  test_g7n_parse_allowed_origins();
  test_trk1_track_upgrade_off();
  test_trk1_track_upgrade_on();
  test_lan_bind();
  test_malformed_inputs_on_lan_listener();
  test_wss(false);

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_ws_test: %d of %d checks failed\n", g_failures, g_checks);
    return 1;
  }
  std::printf("rs_ws_test: all %d checks passed\n", g_checks);
  return 0;
}
