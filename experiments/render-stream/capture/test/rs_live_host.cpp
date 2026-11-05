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
//   GRC_LIVE_CREDIT_WINDOW_MAX  1 or 2 (default 2); invalid -> exit 2
//   GRC_SABOTAGE                no-cors | accept-any-origin | token-ignored (anything else -> 2)
//   GRC_LIVE_EXPOSE             CAR2: loopback (default) | lan; with --token and
//                               GRC_LIVE_ALLOWED_ORIGINS it follows entry.cpp's refusals
//                               (expose-invalid, lan-needs-token, lan-needs-origins; exit 2)
//   GRC_LIVE_LISTEN             CAR2: <host>:<port> of `ws` (default 127.0.0.1 and --port); the
//                               host needs GRC_LIVE_EXPOSE=lan unless loopback (non-loopback; 2)
//   GRC_LIVE_WT_LISTEN          CAR2: the same for `wt` (default 127.0.0.1 and --wt-port)
// and from flags:
//   --port=N          0 (default) binds an ephemeral port
//   --token=VALUE     a bearer session: VALUE is required on /6 upgrades and on GETs, and in a
//                     /7 hello's `token`
//   --max-clients=N   WebSocket admission limit (default 4)
//   --summary=PATH    on SIGTERM/SIGINT, write the hub's live-summary.json (with the serving
//                     totals) to PATH after the linger
//   --carriers=LIST   CAR3: the carriers to start, as GRC_LIVE_CARRIERS (default ws); `wt`
//                     loads the net module (--net-module=PATH, else beside this binary) and
//                     binds UDP --wt-port=N (default 0, ephemeral) with a self-signed certificate
//   --tap-dir=DIR     the hub's tap (rs_live.h LiveConfig::tap_dir; absolute)
//   --evidence-dir=DIR where wt writes live-cert-sha256, and live-carriers.json at stop
//   CAR6 (carrier-design.md "Writing a carrier"): every other name in --carriers is an in-memory
//   consumer carrier (rs_mem_carrier.h) registered through grc_carrier_register, found with
//   dlsym(RTLD_DEFAULT) (this binary exports it, as the capture library does), before the set is
//   built; `ws` starts only when listed. Also registered: `idle`, never listed, which must never
//   start and be destroyed once.
//   --mem-connections=N connections each in-memory carrier opens (default 1)
//   --mem-fault=F       double-release: the third binary buffer is released twice (sabotage)
//   --mem-out=DIR       where each in-memory carrier writes mem-<name>.json and its bytes
//   --skip-register=NAME a listed name left unregistered (carrier-unregistered; exit 2)
//   --register-checks   first registers the refused cases (bad version, short size, a null entry
//                       point, a bad name, ws, wt, a duplicate) and prints each result
//   stdout, CAR6: "RS_LIVE_HOST_REGISTER <case> <result>" per registration, including `late`
//   (one attempt after live started), and at the end "RS_LIVE_HOST_EXT <name> starts=<n>
//   destroys=<n>" per registered carrier.
// stdout: "RS_LIVE_HOST_PORT <port>" first (with wt, then "RS_LIVE_HOST_WT_PORT <port>" and
// "RS_LIVE_HOST_CERT_SHA256 <hex>"), then one line per transport event, in the formats
// entry.cpp logs to stdout.log where it has one (`live: 403 origin <origin> <method> <route>`).
//
// The transport is the CarrierSet (rs_carrier_set.h) with `ws` at index 0, as in entry.cpp.

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
#include <dlfcn.h>

#include "rs_carrier_ext.h"
#include "rs_carrier_set.h"
#include "rs_mem_carrier.h"
#include "rs_expose.h"
#include "rs_net_module.h"
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
  std::string carriers_list = "ws";
  std::string net_module;
  std::string tap_dir;
  std::string evidence_dir;
  unsigned wt_port = 0;
  int mem_connections = 1;
  std::string mem_fault;
  std::string mem_out;
  std::string skip_register;
  bool register_checks = false;
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
    } else if (const char *v = value_of("--carriers")) {
      carriers_list = v;
    } else if (const char *v = value_of("--net-module")) {
      net_module = v;
    } else if (const char *v = value_of("--tap-dir")) {
      tap_dir = v;
    } else if (const char *v = value_of("--evidence-dir")) {
      evidence_dir = v;
    } else if (const char *v = value_of("--wt-port")) {
      wt_port = static_cast<unsigned>(std::strtoul(v, nullptr, 10));
    } else if (const char *v = value_of("--mem-connections")) {
      mem_connections = static_cast<int>(std::strtol(v, nullptr, 10));
    } else if (const char *v = value_of("--mem-fault")) {
      mem_fault = v;
    } else if (const char *v = value_of("--mem-out")) {
      mem_out = v;
    } else if (const char *v = value_of("--skip-register")) {
      skip_register = v;
    } else if (arg == "--register-checks") {
      register_checks = true;
    }
  }

  // entry.cpp's live configuration, from the same variables.
  LiveConfig live_config;
  std::string error;
  // CAR2 (carrier-design.md D10): GRC_LIVE_EXPOSE, GRC_LIVE_LISTEN and GRC_LIVE_WT_LISTEN, through
  // the same functions entry.cpp calls (rs_expose.h).
  grc::live::Expose expose = grc::live::Expose::Loopback;
  std::string wt_host = "127.0.0.1";
  {
    std::string why;
    const auto refuse = [&]() {
      std::fprintf(stderr, "rs_live_host: %s\n", why.c_str());
      std::exit(2);
    };
    if (!grc::live::parse_expose(std::getenv("GRC_LIVE_EXPOSE"), &expose, &why)) refuse();
    const char *listen = std::getenv("GRC_LIVE_LISTEN");
    if (listen != nullptr && *listen != '\0') {
      std::uint16_t port = 0;
      if (!grc::live::parse_listen_address(listen, expose, "GRC_LIVE_LISTEN", &server_config.host, &port, &why)) {
        refuse();
      }
      server_config.port = port;
    }
    const char *wt_listen = std::getenv("GRC_LIVE_WT_LISTEN");
    if (wt_listen != nullptr && *wt_listen != '\0') {
      std::uint16_t port = 0;
      if (!grc::live::parse_listen_address(wt_listen, expose, "GRC_LIVE_WT_LISTEN", &wt_host, &port, &why)) {
        refuse();
      }
      wt_port = port;
    }
  }
  const char *origins = std::getenv("GRC_LIVE_ALLOWED_ORIGINS");
  if (!grc::live::parse_allowed_origins(origins != nullptr ? origins : "", &server_config.allowed_origins,
                                        &error)) {
    std::fprintf(stderr, "rs_live_host: origin-config-invalid: %s\n", error.c_str());
    return 2;
  }
  if (!grc::live::check_expose(expose, !token.empty(), server_config.allowed_origins.size(), &error)) {
    std::fprintf(stderr, "rs_live_host: %s\n", error.c_str());
    return 2;
  }
  server_config.allow_non_loopback = expose == grc::live::Expose::Lan;
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
  live_config.tap_dir = tap_dir;
  std::vector<std::string> carrier_names;
  if (!grc::live::parse_carrier_list(carriers_list.c_str(), &carrier_names, &error)) {
    std::fprintf(stderr, "rs_live_host: %s\n", error.c_str());
    return 2;
  }

  std::signal(SIGINT, on_signal);
  std::signal(SIGTERM, on_signal);

  FixedSource source;
  grc::live::CarrierServices services;
  services.auth_token = token;
  services.allowed_origins = server_config.allowed_origins;
  services.enforce_origins = server_config.enforce_origins;
  services.resources = &source;
  services.log = [](int, const std::string &line) { std::fprintf(stderr, "%s\n", line.c_str()); };
  services.config["path"] = server_config.path;
  services.config["subprotocols"] = "render-stream.7,render-stream.6";
  services.config["hello_token_subprotocols"] = "render-stream.7";
  services.config["max_inbound_text"] = std::to_string(server_config.max_inbound_text);
  services.config["max_queued_bytes"] = std::to_string(server_config.max_queued_bytes);
  services.config["wt_listen"] =
      (wt_host.find(':') != std::string::npos ? "[" + wt_host + "]" : wt_host) + ":" + std::to_string(wt_port);
  services.config["expose"] = expose == grc::live::Expose::Lan ? "lan" : "loopback";
  services.config["wt_cert"] = "self";
  if (!evidence_dir.empty()) services.config["evidence_dir"] = evidence_dir;
  // CAR6: declared before the set, so its report runs after the set destroyed every carrier.
  struct ExtStats {
    std::string name;
    int starts = 0;
    int destroys = 0;
  };
  struct ExtReport {
    std::vector<std::unique_ptr<ExtStats>> stats;
    bool armed = false;  // set once the host reaches its normal end
    ~ExtReport() {
      if (!armed) return;
      for (const auto &st : stats) {
        print("RS_LIVE_HOST_EXT " + st->name + " starts=" + std::to_string(st->starts) +
              " destroys=" + std::to_string(st->destroys));
      }
      print("live: stopped");
    }
  } ext_report;
  std::vector<std::unique_ptr<ExtStats>> &ext_stats = ext_report.stats;
  grc::live::CarrierSet transport(server_config.max_clients, services);
  auto ws_carrier = std::make_unique<grc::live::WsCarrier>(server_config, &source, 2000);
  grc::live::WsCarrier *ws = ws_carrier.get();
  grc::live::NetWtCarrier *wt = nullptr;
  // CAR6: consumer carriers, registered through the exported entry point before the set exists.
  grc_carrier_register_fn register_fn = nullptr;
  const auto ensure_register_fn = [&]() {
    if (register_fn == nullptr) {
      register_fn = reinterpret_cast<grc_carrier_register_fn>(dlsym(RTLD_DEFAULT, "grc_carrier_register"));
      print(std::string("RS_LIVE_HOST_REGISTER dlsym ") + (register_fn != nullptr ? "found" : "missing"));
      if (register_fn == nullptr) std::exit(1);
    }
  };
  const auto mem_options = [&](const std::string &name) {
    grc::test::MemCarrierOptions o;
    o.name = name;
    o.connections = mem_connections;
    o.fault = mem_fault;
    o.out_dir = mem_out;
    o.hello = std::string("{\"type\":\"hello\",\"protocol\":\"render-stream/7\",\"receiver\":\"mem-") + name +
              "\",\"receiver_kind\":\"gsw-canvas\",\"credit_stage\":\"submitted\",\"credit_window\":1,"
              "\"inbound_buffer_bytes\":16777216,\"token\":" +
              (token.empty() ? std::string("null") : "\"" + token + "\"") +
              ",\"manifest_sha256\":null,\"presentation_backing_w\":640,\"presentation_backing_h\":360,"
              "\"presentation_css_w\":640,\"presentation_css_h\":360,\"dpr_milli\":1000}";
    return o;
  };
  const auto register_mem = [&](const std::string &label, const std::string &name) {
    ensure_register_fn();
    ext_stats.push_back(std::make_unique<ExtStats>());
    ExtStats *st = ext_stats.back().get();
    st->name = name;
    grc_carrier_v1 vt = grc::test::make_mem_carrier(mem_options(name), &st->starts, &st->destroys);
    const int rc = register_fn(&vt);
    print("RS_LIVE_HOST_REGISTER " + label + " " + std::to_string(rc));
    if (rc < 0) {
      vt.destroy(vt.self);  // refused: still ours
      ext_stats.pop_back();
    }
    return rc;
  };
  bool any_ext = false;
  for (const std::string &name : carrier_names) any_ext |= name != "ws" && name != "wt";
  if (any_ext || register_checks) {
    ensure_register_fn();
    grc::live::carrier_registry().set_log([](const std::string &line) { std::fprintf(stderr, "%s\n", line.c_str()); });
  }
  if (register_checks) {
    // The refused cases (grc_carrier.h): each returns -1 and leaves the struct with its caller.
    int starts = 0;
    int destroys = 0;
    const auto refused_case = [&](const char *label, void (*mutate)(grc_carrier_v1 *), const char *name) {
      grc::test::MemCarrierOptions o = mem_options(name);
      grc_carrier_v1 vt = grc::test::make_mem_carrier(o, &starts, &destroys);
      mutate(&vt);
      print(std::string("RS_LIVE_HOST_REGISTER ") + label + " " + std::to_string(register_fn(&vt)));
      vt.destroy(vt.self);
    };
    refused_case("bad-version", [](grc_carrier_v1 *v) { v->abi_version = 2; }, "badver");
    refused_case("short-size", [](grc_carrier_v1 *v) { v->size = sizeof(grc_carrier_v1) - 8; }, "short");
    refused_case("null-entry", [](grc_carrier_v1 *v) { v->queued_bytes = nullptr; }, "nullentry");
    refused_case("bad-name", [](grc_carrier_v1 *) {}, "Bad_Name");
    refused_case("reserved-ws", [](grc_carrier_v1 *) {}, "ws");
    refused_case("reserved-wt", [](grc_carrier_v1 *) {}, "wt");
    print("RS_LIVE_HOST_REGISTER refused-touched starts=" + std::to_string(starts) +
          " destroys=" + std::to_string(destroys));
  }
  for (const std::string &name : carrier_names) {
    if (name == "ws" || name == "wt" || name == skip_register) continue;
    register_mem(name, name);
  }
  if (any_ext) register_mem("idle", "idle");  // registered, never listed: never started
  if (register_checks && !carrier_names.empty()) {
    for (const std::string &name : carrier_names) {
      if (name != "ws" && name != "wt" && name != skip_register) {
        // A duplicate of a registered name.
        grc_carrier_v1 vt = grc::test::make_mem_carrier(mem_options(name), nullptr, nullptr);
        print("RS_LIVE_HOST_REGISTER duplicate " + std::to_string(register_fn(&vt)));
        vt.destroy(vt.self);
        break;
      }
    }
  }
  // entry.cpp's arm: registration closes, the listed carriers join the set, the rest are destroyed.
  std::vector<grc::live::RegisteredCarrier> registered = grc::live::carrier_registry().close();
  for (const std::string &name : carrier_names) {
    if (name == "ws") {
      if (!transport.add(grc::live::kCarrierWs, std::move(ws_carrier), &error)) {
        std::fprintf(stderr, "rs_live_host: %s\n", error.c_str());
        return 1;
      }
    } else if (name == "wt") {
      const grc_net_module_table_v1 *m = grc::live::load_net_module(net_module.c_str(), &error);
      std::unique_ptr<grc::live::NetWtCarrier> c =
          m != nullptr ? grc::live::NetWtCarrier::create(m, &error) : nullptr;
      if (c == nullptr) {
        std::fprintf(stderr, "rs_live_host: %s\n", error.c_str());
        return 1;
      }
      wt = c.get();
      if (!transport.add(grc::live::kCarrierWt, std::move(c), &error)) {
        std::fprintf(stderr, "rs_live_host: %s\n", error.c_str());
        return 1;
      }
    } else {
      bool found = false;
      for (auto it = registered.begin(); it != registered.end(); ++it) {
        if (it->name != name) continue;
        std::unique_ptr<grc::live::AbiCarrier> c = grc::live::AbiCarrier::adopt(&it->vtable, &error);
        const std::uint8_t index = it->index;
        registered.erase(it);
        if (c == nullptr || !transport.add(index, std::move(c), &error)) {
          std::fprintf(stderr, "rs_live_host: %s\n", error.c_str());
          return 1;
        }
        found = true;
        break;
      }
      if (!found) {
        std::fprintf(stderr, "rs_live_host: carrier-unregistered: %s\n", name.c_str());
        for (grc::live::RegisteredCarrier &r : registered) r.vtable.destroy(r.vtable.self);
        return 2;
      }
    }
  }
  for (grc::live::RegisteredCarrier &r : registered) r.vtable.destroy(r.vtable.self);  // unlisted
  registered.clear();
  if (!transport.start(&error) || (wt != nullptr && !transport.started(grc::live::kCarrierWt))) {
    std::fprintf(stderr, "rs_live_host: start failed: %s\n%s\n", error.c_str(),
                 transport.carriers_json().c_str());
    return 1;
  }
  const bool has_ws = transport.started(grc::live::kCarrierWs);
  if (any_ext) register_mem("late", "late");  // after live started: carrier-late, -1
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
  print("RS_LIVE_HOST_PORT " + std::to_string(has_ws ? ws->port() : 0));
  if (wt != nullptr) {
    const grc::live::CarrierInfo info = wt->info();
    print("RS_LIVE_HOST_WT_PORT " + std::to_string(info.port));
    print("RS_LIVE_HOST_CERT_SHA256 " + info.cert_sha256);
  }

  std::uint64_t frame = 0;
  const auto drain = [&]() {
    for (const grc::live::Event &event : transport.take_events()) {
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
                " origin=" + event.origin + (event.carrier.empty() ? "" : " carrier=" + event.carrier));
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
  transport.stop();
  if (!evidence_dir.empty()) {
    grc::write_file(evidence_dir + "/live-carriers.json", transport.carriers_json());
  }
  if (!summary_path.empty()) {
    if (!grc::write_file(summary_path, hub.summary_json(&serving))) {
      std::fprintf(stderr, "rs_live_host: cannot write %s\n", summary_path.c_str());
      return 1;
    }
  }
  ext_report.armed = true;  // "live: stopped" is printed once every carrier is destroyed
  return 0;
}
