// Test-only echo server for the rs_ws Node and Godot interop self-tests
// (scripts/test/self-test-rs-ws.ts, receiver/tests/ws_selftest.gd,
// receiver/tests/http_selftest.gd). Not linked into render_stream_capture --
// this is application logic layered on top of grc::live::Server purely so
// an independent client can exercise the transport end to end, over real
// loopback sockets.
//
// Usage: rs_ws_echo [--port N] [--max-clients N] [--max-inbound-text N] [--token VALUE]
//   --port 0 (default) binds an ephemeral port. Either way, the chosen port
//   is printed on its own stdout line: "RS_WS_ECHO_PORT <port>", flushed
//   before anything else, so a driving script can capture it.
//   --token VALUE (gate2-design.md G2e) requires `Authorization: Bearer VALUE`
//   on both the WebSocket upgrade and every resource GET; omitted (the
//   default), neither is checked.
//
// Inbound text is this tiny test-only command language, decided only on the
// text's own shape (the rs_ws transport itself knows nothing about it):
//   - a non-empty string of ASCII digits is a request for a binary push:
//     the server replies with exactly that many bytes, byte[i] = i % 256,
//     deterministic so the client can verify it without round-tripping its
//     own bytes through the inbound-text-only transport;
//   - anything else is echoed back verbatim as text.
//
// HTTP GET (gate2-design.md G2c1): this binary also registers a
// grc::live::ResourceSource (TestResourceSource, below) with the server, so
// the same port serves `GET <resource_prefix><hash>` alongside the
// WebSocket path. The source holds a handful of fixed, hash-named bodies
// (kHash1MiB, kHash8MiB below), each byte[i] = i % 251 -- a different
// modulus from the WS binary-push payload above, so a test that mixed the
// two up would be caught rather than silently pass. kHashUnknown is a
// well-formed (64 lowercase hex) hash the source deliberately never
// registers, for the 404 case. These are test fixtures, not real content
// hashes: nothing here checks that a hash is the SHA-256 of its body (that
// is G2c2's rs_resource_store, over real render-stream-texture/1 payloads).
//
// SIGINT/SIGTERM trigger a graceful stop() (close 1000 to any open
// connection, flush, join) and exit 0.

#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "rs_ws.h"

namespace {

volatile std::sig_atomic_t g_stop = 0;

void on_signal(int) { g_stop = 1; }

bool is_all_digits(const std::string &s) {
  if (s.empty()) return false;
  for (char ch : s) {
    if (ch < '0' || ch > '9') return false;
  }
  return true;
}

std::vector<std::uint8_t> deterministic_payload(std::size_t len) {
  std::vector<std::uint8_t> out(len);
  for (std::size_t i = 0; i < len; ++i) out[i] = static_cast<std::uint8_t>(i % 256);
  return out;
}

// byte[i] = i % 251, for the HTTP resource bodies (see the file header: a deliberately different
// modulus from the WS binary push above).
std::vector<std::uint8_t> resource_payload(std::size_t len) {
  std::vector<std::uint8_t> out(len);
  for (std::size_t i = 0; i < len; ++i) out[i] = static_cast<std::uint8_t>(i % 251);
  return out;
}

// Printed and documented so self-test-rs-ws.ts and http_selftest.gd can request them by name
// without duplicating the literals (they still hardcode the strings -- there is no header shared
// between C++, TypeScript and GDScript -- but a mismatch is a same-file diff away from either).
constexpr std::string_view kHash1MiB = "1111111111111111111111111111111111111111111111111111111111111111";
constexpr std::string_view kHash8MiB = "888888888888888888888888888888888888888888888888888888888888888a";
constexpr std::string_view kHashUnknown = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

class TestResourceSource : public grc::live::ResourceSource {
 public:
  TestResourceSource() {
    bodies_.emplace(std::string(kHash1MiB), std::make_shared<const std::vector<std::uint8_t>>(
                                                 resource_payload(1u << 20)));
    bodies_.emplace(std::string(kHash8MiB), std::make_shared<const std::vector<std::uint8_t>>(
                                                 resource_payload(8u << 20)));
    // kHashUnknown is intentionally absent: lookup() falls through to nullptr (404).
  }

  // Called on the I/O thread (rs_ws.h ResourceSource contract); bodies_ is fixed at construction
  // and never mutated afterwards, so no lock is needed here.
  std::shared_ptr<const std::vector<std::uint8_t>> lookup(std::string_view hash) override {
    const auto it = bodies_.find(std::string(hash));
    return it == bodies_.end() ? nullptr : it->second;
  }

 private:
  std::map<std::string, std::shared_ptr<const std::vector<std::uint8_t>>> bodies_;
};

}  // namespace

int main(int argc, char **argv) {
  grc::live::ServerConfig config;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    auto value_of = [&](const char *flag) -> const char * {
      const std::size_t flag_len = std::strlen(flag);
      if (arg.rfind(flag, 0) != 0) return nullptr;
      if (arg.size() > flag_len && arg[flag_len] == '=') return arg.c_str() + flag_len + 1;
      return nullptr;
    };
    if (const char *v = value_of("--port")) {
      config.port = static_cast<std::uint16_t>(std::strtoul(v, nullptr, 10));
    } else if (const char *v = value_of("--max-clients")) {
      config.max_clients = static_cast<std::size_t>(std::strtoul(v, nullptr, 10));
    } else if (const char *v = value_of("--max-inbound-text")) {
      config.max_inbound_text = static_cast<std::size_t>(std::strtoul(v, nullptr, 10));
    } else if (const char *v = value_of("--token")) {
      config.auth_token = v;
    }
  }
  if (config.max_clients < 4) config.max_clients = 4;  // headroom for back-to-back test connections.

  std::signal(SIGINT, on_signal);
  std::signal(SIGTERM, on_signal);

  TestResourceSource resource_source;
  grc::live::Server server;
  std::string error;
  if (!server.start(config, &resource_source, &error)) {
    std::fprintf(stderr, "rs_ws_echo: start failed: %s\n", error.c_str());
    return 1;
  }
  std::printf("RS_WS_ECHO_PORT %u\n", static_cast<unsigned>(server.port()));
  std::fflush(stdout);

  while (!g_stop) {
    for (const grc::live::Event &event : server.take_events()) {
      switch (event.kind) {
        case grc::live::Event::Opened:
          std::printf("[rs-ws-echo] opened conn=%u\n", event.conn);
          break;
        case grc::live::Event::Text:
          if (is_all_digits(event.text)) {
            const std::size_t len = static_cast<std::size_t>(std::strtoull(event.text.c_str(), nullptr, 10));
            server.send_binary(event.conn, deterministic_payload(len));
            std::printf("[rs-ws-echo] conn=%u binary push %zu bytes\n", event.conn, len);
          } else {
            server.send_text(event.conn, event.text);
            std::printf("[rs-ws-echo] conn=%u text echo %zu bytes\n", event.conn, event.text.size());
          }
          break;
        case grc::live::Event::Closed:
          std::printf("[rs-ws-echo] closed conn=%u code=%u reason=%s\n", event.conn,
                      static_cast<unsigned>(event.code), event.reason.c_str());
          break;
        case grc::live::Event::HttpGet:
          std::printf("[rs-ws-echo] conn=%u http-get hash=%s status=%u bytes=%llu\n", event.conn,
                      event.hash.c_str(), static_cast<unsigned>(event.http_status),
                      static_cast<unsigned long long>(event.bytes));
          break;
        case grc::live::Event::AuthRejected:
          std::printf("[rs-ws-echo] conn=%u auth-rejected\n", event.conn);
          break;
      }
      std::fflush(stdout);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }

  server.stop(2000);
  std::printf("[rs-ws-echo] stopped\n");
  return 0;
}
