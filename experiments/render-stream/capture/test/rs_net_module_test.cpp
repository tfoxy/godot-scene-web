// rs_net_module_test: the capture's net module loader (rs_net_module.h:
// `net-module-missing` and `net-module-abi` refusals), and -- when the real
// module has been built beside this test (scripts/build-rs-net.sh) -- a `wt` carrier through the
// CarrierSet: start, live-carriers.json, stop.
//
// Usage: rs_net_module_test <no-entry fake> <bad-abi fake> <car3 fake> [--require-real-module]
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>

#include "rs_carrier_set.h"
#include "rs_net_module.h"
#include "test_paths.h"

namespace {

int g_failed = 0;

void check(bool ok, const std::string &what) {
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.c_str());
  if (!ok) ++g_failed;
}

bool starts_with(const std::string &s, const std::string &p) { return s.rfind(p, 0) == 0; }

}  // namespace

int main(int argc, char **argv) {
  using namespace grc::live;  // NOLINT
  const bool require_real = argc == 5 && std::strcmp(argv[4], "--require-real-module") == 0;
  if (argc != 4 && !require_real) {
    std::fprintf(stderr, "usage: rs_net_module_test <no-entry> <bad-abi> <car3> [--require-real-module]\n");
    return 2;
  }
  std::string error;
  bool refused = load_net_module_at("/nonexistent/librender_stream_net.so", &error) == nullptr;
  check(refused && starts_with(error, "net-module-missing: "),
        "a missing module is net-module-missing (" + error + ")");
  error.clear();
  refused = load_net_module_at(argv[1], &error) == nullptr;
  check(refused && starts_with(error, "net-module-abi: "),
        "a module without grc_net_module_v1 is net-module-abi (" + error + ")");
  error.clear();
  refused = load_net_module_at(argv[2], &error) == nullptr;
  check(refused && starts_with(error, "net-module-abi: "),
        "a module with another table version is net-module-abi (" + error + ")");
  // TRK3: a CAR3-era table (size 40, no `features`) still loads and serves no tracks.
  error.clear();
  const grc_net_module_table_v1 *car3 = load_net_module_at(argv[3], &error);
  check(car3 != nullptr && car3->size == 40 && !net_module_serves_tracks(car3),
        "TRK3: a size-40 (CAR3-era) module loads and serves no tracks (" + error + ")");
  {
    grc_net_module_table_v1 t{};
    t.abi_version = GRC_NET_MODULE_ABI_VERSION;
    t.size = sizeof(grc_net_module_table_v1);
    t.features = GRC_NET_FEATURE_TRACKS;
    check(sizeof(t) == 48 && net_module_serves_tracks(&t), "TRK3: size 48 with the tracks bit serves tracks");
    t.features = 0;
    check(!net_module_serves_tracks(&t), "TRK3: size 48 with features 0 serves no tracks");
    t.features = 2u;
    check(!net_module_serves_tracks(&t), "TRK3: size 48 with only another bit serves no tracks");
    t.features = GRC_NET_FEATURE_TRACKS;
    t.size = 40;
    check(!net_module_serves_tracks(&t), "TRK3: a size-40 table is never read for features");
    check(!net_module_serves_tracks(nullptr), "TRK3: a null table serves no tracks");
  }
  // CAR4: the TLS entry is looked up on its own; the bad-ABI fake (a CAR3-shaped module) has none.
  {
    void *handle = nullptr;
    error.clear();
    load_net_module_at(argv[2], &error, &handle);
    check(handle != nullptr, "the bad-ABI fake still dlopen()s (its handle is reported)");
    error.clear();
    check(net_tls_table(handle, argv[2], &error) == nullptr && starts_with(error, "net-module-abi: "),
          "a module without grc_net_tls_v1 is net-module-abi for wss (" + error + ")");
    error.clear();
    check(net_tls_table(nullptr, "x", &error) == nullptr && starts_with(error, "net-module-missing: "),
          "no handle is net-module-missing (" + error + ")");
  }
  const std::string beside = default_net_module_path();
  check(beside.ends_with("/" + grc::rs::library_file_name("render_stream_net")),
        "the default path is beside this binary (" + beside + ")");

  if (!std::filesystem::exists(grc::rs::fs_path(beside))) {
    if (require_real) {
      check(false, "required real module missing: " + beside);
      return 1;
    }
    std::printf("skip the real-module checks: %s not built (scripts/build-rs-net.sh)\n", beside.c_str());
    return g_failed == 0 ? 0 : 1;
  }
  error.clear();
  const grc_net_module_table_v1 *m = load_net_module(nullptr, &error);
  check(m != nullptr, "the real module loads (" + error + ")");
  if (m == nullptr) return 1;
  std::printf("info real table: abi_version=%u size=%u carrier_abi_version=%u features=%llu module_version=%s\n",
              m->abi_version, m->size, m->carrier_abi_version,
              static_cast<unsigned long long>(m->features), m->module_version ? m->module_version : "?");
  check(m->carrier_abi_version == GRC_CARRIER_ABI_VERSION && m->module_version != nullptr &&
            starts_with(m->module_version, "render-stream-net "),
        std::string("its table: carrier ABI 1, version ") + (m->module_version ? m->module_version : "?"));
  check(load_net_module(nullptr, &error) == m, "loaded once (cached)");
  error.clear();
  const grc_net_tls_table_v1 *tls = load_net_tls(nullptr, &error);
  check(tls != nullptr && tls->abi_version == GRC_NET_TLS_ABI_VERSION && tls->module_version != nullptr &&
            std::strcmp(tls->module_version, m->module_version) == 0,
        "CAR4: the real module's grc_net_tls_v1, version 1, same module version (" + error + ")");
  if (tls != nullptr) {
    error.clear();
    check(NetTlsContext::create(tls, "/nonexistent/cert.pem", "/nonexistent/key.pem", &error) == nullptr &&
              starts_with(error, "tls-config-invalid: "),
          "an unreadable pair is tls-config-invalid (" + error + ")");
  }

  const std::string dir = grc::test::temp_directory("rs-net-module-test");
  check(!dir.empty(), "an evidence dir");
  CarrierServices services;
  services.config["wt_listen"] = "127.0.0.1:0";
  services.config["path"] = "/render-stream";
  services.config["subprotocols"] = "render-stream.13,render-stream.7,render-stream.6";
  services.config["hello_token_subprotocols"] = "render-stream.7,render-stream.13";
  services.config["max_inbound_text"] = "4096";
  services.config["max_queued_bytes"] = "67108864";
  services.config["wt_cert"] = "self";
  services.config["evidence_dir"] = dir;
  CarrierSet set(2, services);
  std::unique_ptr<NetWtCarrier> wt = NetWtCarrier::create(m, &error);
  check(wt != nullptr, "wt_create (" + error + ")");
  if (wt == nullptr) {
    grc::test::remove_tree(dir);
    return 1;
  }
  NetWtCarrier *raw = wt.get();
  check(set.add(kCarrierWt, std::move(wt), &error), "added as index 1 (" + error + ")");
  check(set.start(&error), "started (" + error + ")");
  const std::string json = set.carriers_json();
  std::printf("%s\n", json.c_str());
  const CarrierInfo info = raw->info();
  check(info.transport == "udp" && info.port > 0 && info.address == "127.0.0.1",
        "bound udp 127.0.0.1:" + std::to_string(info.port));
  check(info.tls == "self-signed" && info.cert_sha256.size() == 64, "self-signed, sha256 " + info.cert_sha256);
  FILE *f = grc::rs::open_file(dir + "/live-cert-sha256", "r");
  char line[80] = {0};
  if (f != nullptr) {
    if (std::fgets(line, sizeof line, f) == nullptr) line[0] = '\0';
    std::fclose(f);
  }
  check(std::string(line) == info.cert_sha256 + "\n", "evidence/live-cert-sha256 is the hash");
  check(json.find("\"name\":\"wt\"") != std::string::npos &&
            json.find("\"transport\":\"udp\"") != std::string::npos &&
            json.find("\"module_version\":\"render-stream-net ") != std::string::npos,
        "live-carriers.json names wt over udp with its module version");
  check(set.take_events().empty(), "no events without a client");
  set.stop();
  check(raw->abi().outstanding_buffers() == 0, "no host buffer outstanding after stop");
  check(grc::test::remove_tree(dir), "remove the evidence dir recursively");
  return g_failed == 0 ? 0 : 1;
}
