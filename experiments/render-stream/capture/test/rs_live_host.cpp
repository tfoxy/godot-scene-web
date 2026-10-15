// Test-only live host for the G7n Node interop self-test (scripts/test/self-test-rs-ws.ts,
// gate7-design.md G7n "Checks"). Not linked into render_stream_capture. It wires the production
// pieces exactly as entry.cpp does -- grc::live::Server (rs_ws) with both subprotocols and the
// Origin allowlist, and grc::rs2::Hub (rs_live) with the /7 hello token check -- around a fixed
// one-item scene instead of the mirror, so an independent client can drive /6 and /7 connections,
// the hello token, the 403s and the CORS preflight end to end over real loopback sockets without
// an engine.
//
// Configuration is read from the same environment variables entry.cpp reads, with the same
// rules, so the sabotage cases exercise the same switches:
//   GRC_LIVE_ALLOWED_ORIGINS    comma list (rs_ws.h parse_allowed_origins); invalid -> exit 2
//   GRC_LIVE_CREDIT_WINDOW_MAX  1 or 2 (default 1); invalid -> exit 2
//   GRC_SABOTAGE                no-cors | accept-any-origin | token-ignored (anything else -> 2)
// and from flags:
//   --port=N          0 (default) binds an ephemeral port
//   --token=VALUE     a bearer session: VALUE is required on /6 upgrades and on GETs, and in a
//                     /7 hello's `token`
//   --max-clients=N   WebSocket admission limit (default 4)
//   --summary=PATH    on SIGTERM/SIGINT, write the hub's live-summary.json (with the serving
//                     totals) to PATH after the linger
// stdout: "RS_LIVE_HOST_PORT <port>" first, then one line per transport event, in the formats
// entry.cpp logs to stdout.log where it has one (`live: 403 origin <origin> <method> <route>`).

#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "report.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"
#include "rs_live.h"
#include "rs_publish.h"
#include "rs_ws.h"

namespace {

using namespace grc::rs2;  // NOLINT

volatile std::sig_atomic_t g_stop = 0;
void on_signal(int) { g_stop = 1; }

// The one servable resource, by hash; anything else is 404 (rs_ws_echo.cpp's kHash1MiB pattern,
// shorter).
constexpr std::string_view kHash = "1111111111111111111111111111111111111111111111111111111111111111";

class FixedSource : public grc::live::ResourceSource {
 public:
  FixedSource() {
    std::vector<std::uint8_t> body(1024);
    for (std::size_t i = 0; i < body.size(); ++i) body[i] = static_cast<std::uint8_t>(i % 251);
    body_ = std::make_shared<const std::vector<std::uint8_t>>(std::move(body));
  }
  std::shared_ptr<const std::vector<std::uint8_t>> lookup(std::string_view hash) override {
    return hash == kHash ? body_ : nullptr;
  }

 private:
  std::shared_ptr<const std::vector<std::uint8_t>> body_;
};

// golden-7's rate scene (one root canvas, one item, one add_rect), as a V6 snapshot.
grc::rs::Captured scene() {
  ItemState it;
  it.id = 1;
  it.origin = Origin::Created;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = kIdentityXform;
  it.content_version = 1;
  Command rect;
  rect.kind = CommandKind::AddRect;
  rect.antialiased = false;
  rect.rect = Rect4{0.0f, 0.0f, 16.0f, 16.0f};
  rect.color = kWhite;
  it.commands = {rect};
  grc::rs::Captured out;
  out.state.version = ProtocolVersion::V6;
  out.state.canvases = {golden::root_canvas({1})};
  out.state.items = {it};
  return out;
}

std::uint64_t now_ns() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now().time_since_epoch())
                                        .count());
}

void print(const std::string &line) {
  std::printf("%s\n", line.c_str());
  std::fflush(stdout);
}

}  // namespace

int main(int argc, char **argv) {
  grc::live::ServerConfig server_config;
  server_config.max_clients = 4;
  std::string token;
  std::string summary_path;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    const auto value_of = [&](const char *flag) -> const char * {
      const std::size_t n = std::strlen(flag);
      return arg.rfind(flag, 0) == 0 && arg.size() > n && arg[n] == '=' ? arg.c_str() + n + 1 : nullptr;
    };
    if (const char *v = value_of("--port")) {
      server_config.port = static_cast<std::uint16_t>(std::strtoul(v, nullptr, 10));
    } else if (const char *v = value_of("--token")) {
      token = v;
    } else if (const char *v = value_of("--max-clients")) {
      server_config.max_clients = static_cast<std::size_t>(std::strtoul(v, nullptr, 10));
    } else if (const char *v = value_of("--summary")) {
      summary_path = v;
    }
  }

  // entry.cpp's live configuration, from the same variables.
  LiveConfig live_config;
  std::string error;
  const char *origins = std::getenv("GRC_LIVE_ALLOWED_ORIGINS");
  if (!grc::live::parse_allowed_origins(origins != nullptr ? origins : "", &server_config.allowed_origins,
                                        &error)) {
    std::fprintf(stderr, "rs_live_host: origin-config-invalid: %s\n", error.c_str());
    return 2;
  }
  const char *window = std::getenv("GRC_LIVE_CREDIT_WINDOW_MAX");
  if (window != nullptr && *window != '\0') {
    const std::string w(window);
    if (w != "1" && w != "2") {
      std::fprintf(stderr, "rs_live_host: invalid GRC_LIVE_CREDIT_WINDOW_MAX (1 or 2)\n");
      return 2;
    }
    live_config.credit_window_max = w == "2" ? 2 : 1;
  }
  const char *sabotage_env = std::getenv("GRC_SABOTAGE");
  const std::string sabotage = sabotage_env != nullptr ? sabotage_env : "";
  if (!sabotage.empty() && sabotage != "no-cors" && sabotage != "accept-any-origin" &&
      sabotage != "token-ignored") {
    std::fprintf(stderr, "rs_live_host: GRC_SABOTAGE %s is not a listener sabotage\n", sabotage.c_str());
    return 2;
  }
  server_config.subprotocols = {kSubprotocolV7, "render-stream.6"};
  server_config.hello_token_subprotocols = {kSubprotocolV7};
  server_config.auth_token = token;
  server_config.enforce_origins = sabotage != "accept-any-origin";
  server_config.cors_headers = sabotage != "no-cors";
  live_config.auth_token = token;
  live_config.token_ignored = sabotage == "token-ignored";

  std::signal(SIGINT, on_signal);
  std::signal(SIGTERM, on_signal);

  FixedSource source;
  grc::live::Server server;
  if (!server.start(server_config, &source, &error)) {
    std::fprintf(stderr, "rs_live_host: start failed: %s\n", error.c_str());
    return 1;
  }
  ServerTransport transport(&server);
  Session tmpl = golden::golden_session_v6(Encoding::Patch, std::string(), generate_id(), Delivery::OutOfBand);
  tmpl.stream = StreamInfo();
  ResourcePolicy policy;
  policy.permitted_formats = {"L8", "LA8", "R8", "RG8", "RGB8", "RGBA8"};
  policy.max_payload_bytes = 16777216;
  tmpl.resources = resources_info(policy, Fetch::Http);
  tmpl.resources.auth = token.empty() ? Auth::None : Auth::Bearer;
  Hub hub(&transport, live_config, tmpl);
  ServingSummary serving;
  const grc::rs::Captured snapshot = scene();
  print("RS_LIVE_HOST_PORT " + std::to_string(server.port()));

  std::uint64_t frame = 0;
  const auto drain = [&]() {
    for (const grc::live::Event &event : server.take_events()) {
      switch (event.kind) {
        case grc::live::Event::HttpGet: {
          const bool preflight = event.method == "OPTIONS";
          if (preflight) {
            ++serving.preflights;
          } else {
            ++serving.http_gets;
            if (event.http_status == 200) {
              serving.http_bytes += event.bytes;
            } else {
              ++serving.http_errors;
            }
          }
          hub.on_http_get(event.hash, event.http_status, event.bytes, event.t_ns, frame, preflight);
          print("live: http " + event.method + " " + std::to_string(event.http_status) + " origin=" +
                event.origin);
          break;
        }
        case grc::live::Event::OriginRejected:
          ++serving.origin_rejected;
          print("live: 403 origin " + event.origin + " " + event.method + " " + event.route);
          break;
        case grc::live::Event::AuthRejected:
          print("live: 401 unauthorized upgrade (missing or wrong bearer token)");
          break;
        case grc::live::Event::Opened:
          print("live: opened conn=" + std::to_string(event.conn) + " subprotocol=" + event.subprotocol +
                " origin=" + event.origin);
          hub.on_event(to_live_event(event), frame);
          break;
        case grc::live::Event::Text:
        case grc::live::Event::Closed:
          hub.on_event(to_live_event(event), frame);
          break;
      }
    }
  };

  while (!g_stop) {
    ++frame;
    drain();
    const std::uint64_t now = now_ns();
    hub.on_frame(frame, now, hub.wants_snapshot(frame, now) ? &snapshot : nullptr, 1, 0);
    std::this_thread::sleep_for(std::chrono::milliseconds(16));
  }

  // entry.cpp's shutdown: the end record, a linger for the receivers to close, then the rest.
  // Everything the I/O thread already answered reaches the hub before the end records go out.
  drain();
  hub.finish(EndReason::Shutdown, frame, now_ns());
  const std::uint64_t deadline = now_ns() + 1500ull * 1000ull * 1000ull;
  while (hub.open_connections() > 0 && now_ns() < deadline) {
    drain();
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  drain();
  hub.close_open(frame);
  server.stop(2000);
  if (!summary_path.empty()) {
    if (!grc::write_file(summary_path, hub.summary_json(&serving))) {
      std::fprintf(stderr, "rs_live_host: cannot write %s\n", summary_path.c_str());
      return 1;
    }
  }
  print("live: stopped");
  return 0;
}
