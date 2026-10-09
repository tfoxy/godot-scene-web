// Unit test for rs_ws (src/rs_ws.h), the dependency-free RFC 6455 server
// (protocol/gate1-design.md G1c1) and its HTTP GET resource serving
// (protocol/gate2-design.md G2c1).
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
//
// The raw-socket client below is a second, independent implementation of
// the wire format (client side): it is deliberately not shared code with
// src/rs_ws.cpp, so a bug that is symmetric between encode and decode would
// not cancel out.

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
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

#include "rs_sha1.h"
#include "rs_ws.h"

namespace {

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

int connect_loopback(std::uint16_t port) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  timeval tv{};
  tv.tv_sec = 5;
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (::connect(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0) {
    ::close(fd);
    return -1;
  }
  return fd;
}

bool recv_exact(int fd, std::uint8_t *buf, std::size_t len) {
  std::size_t have = 0;
  while (have < len) {
    const ssize_t n = ::recv(fd, buf + have, len - have, 0);
    if (n <= 0) return false;
    have += static_cast<std::size_t>(n);
  }
  return true;
}

// Reads whatever is available right now (one recv call, with the socket's
// receive timeout), for reading an HTTP response or a short error frame.
std::vector<std::uint8_t> recv_some(int fd) {
  std::uint8_t buf[8192];
  const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
  if (n <= 0) return {};
  return std::vector<std::uint8_t>(buf, buf + n);
}

std::string http_request(const std::string &key, const std::string &path, const std::string &subprotocol_header) {
  std::string req = "GET " + path + " HTTP/1.1\r\n";
  req += "Host: 127.0.0.1\r\n";
  req += "Upgrade: websocket\r\n";
  req += "Connection: Upgrade\r\n";
  req += "Sec-WebSocket-Key: " + key + "\r\n";
  req += "Sec-WebSocket-Version: 13\r\n";
  if (!subprotocol_header.empty()) req += "Sec-WebSocket-Protocol: " + subprotocol_header + "\r\n";
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
ServerFrame read_server_frame(int fd) {
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

Handshake do_handshake(int fd, const std::string &key, const std::string &path = "/render-stream",
                        const std::string &subprotocol_header = "render-stream.1") {
  const std::string req = http_request(key, path, subprotocol_header);
  ::send(fd, req.data(), req.size(), 0);
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
HttpResponse read_http_response(int fd) {
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
    const ssize_t n = ::recv(fd, chunk, sizeof(chunk), 0);
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
    const ssize_t n = ::recv(fd, chunk, sizeof(chunk), 0);
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

  const int fd = connect_loopback(server.port());
  check(fd >= 0, "connect for RFC vector");
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(hs.status == 101, "RFC vector handshake status 101");
  check(hs.raw.find("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") != std::string::npos,
        "RFC 6455 ssec 1.3 accept key: got " + hs.raw);
  check(hs.raw.find("Sec-WebSocket-Protocol: render-stream.1") != std::string::npos, "subprotocol echoed");
  check(expect_opened(server) != 0, "Opened event after a good handshake");
  ::close(fd);
  server.stop(1000);
}

void test_masked_text_roundtrip() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for text roundtrip");

  const auto frame = client_text("hello render-stream");
  ::send(fd, frame.data(), frame.size(), 0);
  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events[0].kind == grc::live::Event::Text && events[0].text == "hello render-stream",
        "masked text arrives as a Text event");
  ::close(fd);
  server.stop(1000);
}

void test_frame_header_length_classes() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
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
  ::close(fd);
  server.stop(1000);
}

void test_ping_pong() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened for ping/pong");

  const std::vector<std::uint8_t> ping_payload = {'p', 'i', 'n', 'g', '!'};
  const auto frame = client_frame(0x9, ping_payload);
  ::send(fd, frame.data(), frame.size(), 0);
  const ServerFrame pong = read_server_frame(fd);
  check(pong.ok && pong.opcode == 0xA && pong.payload == ping_payload, "pong echoes the ping payload");
  check(wait_events(server, 1, 300).empty(), "ping/pong produces no Event");
  ::close(fd);
  server.stop(1000);
}

void test_close_handshake() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for close");

  std::vector<std::uint8_t> close_payload = {0x03, 0xE8};  // 1000, big-endian, no reason.
  const auto frame = client_frame(0x8, close_payload);
  ::send(fd, frame.data(), frame.size(), 0);
  const ServerFrame echoed = read_server_frame(fd);
  check(echoed.ok && echoed.opcode == 0x8, "server echoes a close frame");
  check(echoed.payload.size() >= 2 && echoed.payload[0] == 0x03 && echoed.payload[1] == 0xE8,
        "echoed close code is 1000");

  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events.back().kind == grc::live::Event::Closed && events.back().code == 1000,
        "Closed event with code 1000 after a peer-initiated close");

  std::uint8_t probe;
  const ssize_t n = ::recv(fd, &probe, 1, 0);
  check(n == 0, "TCP connection actually closes after the close handshake");
  ::close(fd);
  server.stop(1000);
}

void test_fragmentation_rejected() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened for fragmentation");

  const auto frame = client_text("partial", /*fin=*/false);
  ::send(fd, frame.data(), frame.size(), 0);
  const ServerFrame close_frame = read_server_frame(fd);
  check(close_frame.ok && close_frame.opcode == 0x8 && close_frame.payload.size() >= 2 &&
            ((static_cast<std::uint16_t>(close_frame.payload[0]) << 8) | close_frame.payload[1]) == 1002,
        "fragmentation closes with 1002");
  ::close(fd);
  server.stop(1000);
}

void test_binary_inbound_rejected() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened for binary-inbound rejection");

  const auto frame = client_frame(0x2, {1, 2, 3, 4});
  ::send(fd, frame.data(), frame.size(), 0);
  const ServerFrame close_frame = read_server_frame(fd);
  check(close_frame.ok && close_frame.opcode == 0x8 && close_frame.payload.size() >= 2 &&
            ((static_cast<std::uint16_t>(close_frame.payload[0]) << 8) | close_frame.payload[1]) == 1003,
        "binary inbound closes with 1003");
  ::close(fd);
  server.stop(1000);
}

void test_unmasked_inbound_rejected() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened for unmasked rejection");

  const auto frame = client_text("not masked", /*fin=*/true, /*masked=*/false);
  ::send(fd, frame.data(), frame.size(), 0);
  const ServerFrame close_frame = read_server_frame(fd);
  check(close_frame.ok && close_frame.opcode == 0x8 && close_frame.payload.size() >= 2 &&
            ((static_cast<std::uint16_t>(close_frame.payload[0]) << 8) | close_frame.payload[1]) == 1002,
        "unmasked inbound closes with 1002");
  ::close(fd);
  server.stop(1000);
}

void test_text_too_long() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.max_inbound_text = 16;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened for too-long text");

  const auto frame = client_text("this text is longer than sixteen bytes");
  ::send(fd, frame.data(), frame.size(), 0);
  const ServerFrame close_frame = read_server_frame(fd);
  check(close_frame.ok && close_frame.opcode == 0x8 && close_frame.payload.size() >= 2 &&
            ((static_cast<std::uint16_t>(close_frame.payload[0]) << 8) | close_frame.payload[1]) == 1009,
        "over-long text closes with 1009");
  ::close(fd);
  server.stop(1000);
}

void test_wrong_path_404() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/wrong-path");
  check(hs.status == 404, "wrong path -> 404, got " + std::to_string(hs.status));
  check(wait_events(server, 1, 300).empty(), "a rejected handshake pushes no event");
  ::close(fd);
  server.stop(1000);
}

void test_missing_subprotocol_400() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  const Handshake hs = do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==", "/render-stream", /*subprotocol_header=*/"");
  check(hs.status == 400, "missing subprotocol -> 400, got " + std::to_string(hs.status));
  ::close(fd);
  server.stop(1000);
}

void test_malformed_request_400() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  const std::string garbage = "not even http\r\n\r\n";
  ::send(fd, garbage.data(), garbage.size(), 0);
  const auto bytes = recv_some(fd);
  const std::string raw(bytes.begin(), bytes.end());
  check(raw.rfind("HTTP/1.1 400", 0) == 0, "malformed request -> 400, got " + raw);
  ::close(fd);
  server.stop(1000);
}

void test_max_clients_503() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  config.max_clients = 1;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);

  const int fd1 = connect_loopback(server.port());
  const Handshake hs1 = do_handshake(fd1, "dGhlIHNhbXBsZSBub25jZQ==");
  check(hs1.status == 101, "first client admitted");
  check(expect_opened(server) != 0, "first client opened");

  const int fd2 = connect_loopback(server.port());
  const Handshake hs2 = do_handshake(fd2, "AAAAAAAAAAAAAAAAAAAAAA==");
  check(hs2.status == 503, "second client over max_clients -> 503, got " + std::to_string(hs2.status));

  ::close(fd1);
  ::close(fd2);
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
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for queue limit");

  const std::vector<std::uint8_t> big(4096, 0x42);
  check(!server.send_binary(conn, big), "a single send over max_queued_bytes is refused");
  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events.back().kind == grc::live::Event::Closed && events.back().code == 1008,
        "queued-bytes overflow closes with 1008");
  ::close(fd);
  server.stop(1000);
}

void test_stats_track_sent_bytes() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for stats");

  check(server.send_text(conn, "abc"), "send_text for stats");
  const auto stats = wait_stats_until(
      server, conn, +[](const grc::live::Server::ConnStats &s) { return s.sent_messages >= 1; }, 2000);
  check(stats.sent_messages == 1, "sent_messages == 1");
  check(stats.sent_bytes >= 5, "sent_bytes includes the frame header");
  check(server.stats(999999).sent_messages == 0, "stats() for an unknown connection is zero");
  ::close(fd);
  server.stop(1000);
}

void test_large_binary_4mib() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "opened for 4 MiB binary");

  const std::size_t len = 4u << 20;
  std::vector<std::uint8_t> payload(len);
  for (std::size_t i = 0; i < len; ++i) payload[i] = static_cast<std::uint8_t>((i * 31 + 7) % 256);
  check(server.send_binary(conn, payload), "send_binary 4 MiB");
  const ServerFrame frame = read_server_frame(fd);
  check(frame.ok && frame.opcode == 0x2 && frame.payload == payload, "4 MiB binary arrives byte-exact");
  ::close(fd);
  server.stop(1000);
}

void test_stop_closes_open_connections() {
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, nullptr, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  do_handshake(fd, "dGhlIHNhbXBsZSBub25jZQ==");
  check(expect_opened(server) != 0, "opened before stop()");

  server.stop(2000);
  const ServerFrame close_frame = read_server_frame(fd);
  check(close_frame.ok && close_frame.opcode == 0x8 && close_frame.payload.size() >= 2 &&
            ((static_cast<std::uint16_t>(close_frame.payload[0]) << 8) | close_frame.payload[1]) == 1000,
        "stop() sends close 1000 to an open connection");
  std::uint8_t probe;
  check(::recv(fd, &probe, 1, 0) == 0, "stop() actually closes the TCP connection");
  ::close(fd);
}

// --- HTTP GET resource serving (gate2-design.md G2c1). ---

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
    const int fd = connect_loopback(server.port());
    check(fd >= 0, "connect for size " + std::to_string(sizes[i]));
    const std::string req = plain_http_request("GET", config.resource_prefix + hashes[i]);
    ::send(fd, req.data(), req.size(), 0);
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
    ::close(fd);
  }
  server.stop(1000);
}

void test_http_404_unknown_hash() {
  FakeResourceSource source;
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);
  const int fd = connect_loopback(server.port());
  const std::string req = plain_http_request("GET", config.resource_prefix + make_hash('e'));
  ::send(fd, req.data(), req.size(), 0);
  const HttpResponse resp = read_http_response(fd);
  check(resp.ok && resp.status == 404, "unknown hash -> 404, got " + std::to_string(resp.status));
  check(resp.body.empty(), "404 body is empty");
  ::close(fd);
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
    const int fd = connect_loopback(server.port());
    const std::string req = plain_http_request("GET", path);
    ::send(fd, req.data(), req.size(), 0);
    const HttpResponse resp = read_http_response(fd);
    check(resp.ok && resp.status == 400, "malformed hash '" + path + "' -> 400, got " + std::to_string(resp.status));
    ::close(fd);
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
  const int fd = connect_loopback(server.port());
  const std::string req = plain_http_request("POST", config.resource_prefix + hash);
  ::send(fd, req.data(), req.size(), 0);
  const HttpResponse resp = read_http_response(fd);
  check(resp.ok && resp.status == 405, "POST -> 405, got " + std::to_string(resp.status));
  check(resp.headers.count("allow") != 0 && resp.headers.at("allow") == "GET", "405 carries Allow: GET");
  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events[0].kind == grc::live::Event::HttpGet && events[0].hash == hash &&
            events[0].http_status == 405,
        "405 is also reported as an HttpGet event naming the attempted hash");
  ::close(fd);
  server.stop(1000);
}

void test_http_if_none_match_304() {
  FakeResourceSource source;
  const std::string hash = make_hash('5');
  source.set(hash, pattern_bytes(256, 9));
  grc::live::Server server;
  grc::live::ServerConfig config;
  std::string error;
  check(server.start(config, &source, &error), "server starts: " + error);

  const int fd = connect_loopback(server.port());
  const std::string req1 = plain_http_request("GET", config.resource_prefix + hash);
  ::send(fd, req1.data(), req1.size(), 0);
  const HttpResponse resp1 = read_http_response(fd);
  check(resp1.ok && resp1.status == 200, "first GET is 200");

  const std::string req2 = plain_http_request("GET", config.resource_prefix + hash, {{"If-None-Match", "\"" + hash + "\""}});
  ::send(fd, req2.data(), req2.size(), 0);
  const HttpResponse resp2 = read_http_response(fd);
  check(resp2.ok && resp2.status == 304, "If-None-Match -> 304, got " + std::to_string(resp2.status));
  check(resp2.body.empty(), "304 body is empty");
  check(resp2.headers.count("etag") != 0 && resp2.headers.at("etag") == "\"" + hash + "\"", "304 carries ETag");
  ::close(fd);
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

  const int fd = connect_loopback(server.port());
  const std::string req1 = plain_http_request("GET", config.resource_prefix + hash_a);
  ::send(fd, req1.data(), req1.size(), 0);
  const HttpResponse resp1 = read_http_response(fd);
  check(resp1.ok && resp1.status == 200 && resp1.body == pattern_bytes(32, 1), "first request on the connection");

  const std::string req2 = plain_http_request("GET", config.resource_prefix + hash_b);
  const ssize_t sent = ::send(fd, req2.data(), req2.size(), 0);
  check(sent == static_cast<ssize_t>(req2.size()), "second request sent on the same (still-open) connection");
  const HttpResponse resp2 = read_http_response(fd);
  check(resp2.ok && resp2.status == 200 && resp2.body == pattern_bytes(48, 2),
        "second request on the same connection, keep-alive");
  ::close(fd);
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

  const int fd = connect_loopback(server.port());
  const std::string req = plain_http_request("GET", config.resource_prefix + hash, {{"Connection", "close"}});
  ::send(fd, req.data(), req.size(), 0);
  const HttpResponse resp = read_http_response(fd);
  check(resp.ok && resp.status == 200, "200 despite Connection: close");
  check(resp.headers.count("connection") != 0 && resp.headers.at("connection") == "close",
        "response echoes Connection: close");
  std::uint8_t probe;
  check(::recv(fd, &probe, 1, 0) == 0, "Connection: close actually closes the TCP connection");
  ::close(fd);
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

  int fds[3];
  for (int i = 0; i < 3; ++i) {
    fds[i] = connect_loopback(server.port());
    const std::string req = plain_http_request("GET", config.resource_prefix + hash);
    ::send(fds[i], req.data(), req.size(), 0);
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
  for (int fd : fds) ::close(fd);
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

  const int ws_fd = connect_loopback(server.port());
  do_handshake(ws_fd, "dGhlIHNhbXBsZSBub25jZQ==");
  const std::uint32_t conn = expect_opened(server);
  check(conn != 0, "WebSocket session opened before any HTTP traffic");

  const int http_fd = connect_loopback(server.port());
  const std::string req = plain_http_request("GET", config.resource_prefix + hash);
  ::send(http_fd, req.data(), req.size(), 0);
  const HttpResponse resp = read_http_response(http_fd);
  check(resp.ok && resp.status == 200 && resp.body == pattern_bytes(128, 5),
        "HTTP GET succeeds alongside an open WebSocket session");
  ::close(http_fd);

  // The successful GET above already pushed its own HttpGet event; drain and check it before
  // sending on the WebSocket, so the Text event below isn't waiting behind it in the queue.
  const auto http_events = wait_events(server, 1, 2000);
  check(!http_events.empty() && http_events[0].kind == grc::live::Event::HttpGet &&
            http_events[0].hash == hash && http_events[0].http_status == 200 && http_events[0].bytes == 128,
        "the HTTP GET is also reported as an HttpGet event");

  const auto frame = client_text("still alive");
  ::send(ws_fd, frame.data(), frame.size(), 0);
  const auto events = wait_events(server, 1, 2000);
  check(!events.empty() && events[0].kind == grc::live::Event::Text && events[0].text == "still alive",
        "the WebSocket session still carries data after a concurrent HTTP fetch");
  ::close(ws_fd);
  server.stop(1000);
}

void test_no_mmap_mprotect_imports() {
  char exe_path[4096];
  const ssize_t n = ::readlink("/proc/self/exe", exe_path, sizeof(exe_path) - 1);
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
}

}  // namespace

int main() {
  test_sha1_vectors();
  test_handshake_accept_key_rfc_vector();
  test_masked_text_roundtrip();
  test_frame_header_length_classes();
  test_ping_pong();
  test_close_handshake();
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
  test_http_keep_alive_two_requests_one_connection();
  test_http_connection_close_honoured();
  test_http_max_http_clients_503();
  test_http_coexists_with_websocket();
  test_no_mmap_mprotect_imports();

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_ws_test: %d of %d checks failed\n", g_failures, g_checks);
    return 1;
  }
  std::printf("rs_ws_test: all %d checks passed\n", g_checks);
  return 0;
}
