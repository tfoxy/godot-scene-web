// Test-only echo server for the rs_ws Node and Godot interop self-tests
// (scripts/test/self-test-rs-ws.ts, receiver/tests/ws_selftest.gd).
// Not linked into render_stream_capture -- this is application logic layered
// on top of grc::live::Server purely so an independent client can exercise
// the transport end to end, over real loopback sockets.
//
// Usage: rs_ws_echo [--port N] [--max-clients N] [--max-inbound-text N]
//   --port 0 (default) binds an ephemeral port. Either way, the chosen port
//   is printed on its own stdout line: "RS_WS_ECHO_PORT <port>", flushed
//   before anything else, so a driving script can capture it.
//
// Inbound text is this tiny test-only command language, decided only on the
// text's own shape (the rs_ws transport itself knows nothing about it):
//   - a non-empty string of ASCII digits is a request for a binary push:
//     the server replies with exactly that many bytes, byte[i] = i % 256,
//     deterministic so the client can verify it without round-tripping its
//     own bytes through the inbound-text-only transport;
//   - anything else is echoed back verbatim as text.
//
// SIGINT/SIGTERM trigger a graceful stop() (close 1000 to any open
// connection, flush, join) and exit 0.

#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
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
    }
  }
  if (config.max_clients < 4) config.max_clients = 4;  // headroom for back-to-back test connections.

  std::signal(SIGINT, on_signal);
  std::signal(SIGTERM, on_signal);

  grc::live::Server server;
  std::string error;
  if (!server.start(config, &error)) {
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
      }
      std::fflush(stdout);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }

  server.stop(2000);
  std::printf("[rs-ws-echo] stopped\n");
  return 0;
}
