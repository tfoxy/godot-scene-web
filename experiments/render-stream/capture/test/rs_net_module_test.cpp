// rs_net_module_test: the capture's net module loader (rs_net_module.h; carrier-design.md D8,
// Q3, CAR3 "Checks": `net-module-missing` and `net-module-abi` refusals), and -- when the real
// module has been built beside this test (scripts/build-rs-net.sh) -- a `wt` carrier through the
// CarrierSet: start, live-carriers.json, stop.
//
// Usage: rs_net_module_test <no-entry fake .so> <bad-abi fake .so>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include "rs_carrier_set.h"
#include "rs_net_module.h"

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
  if (argc != 3) {
    std::fprintf(stderr, "usage: rs_net_module_test <no-entry.so> <bad-abi.so>\n");
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
  const std::string beside = default_net_module_path();
  check(beside.size() > 24 && beside.substr(beside.size() - 24) == "/librender_stream_net.so",
        "the default path is beside this binary (" + beside + ")");

  struct stat st {};
  if (stat(beside.c_str(), &st) != 0) {
    std::printf("skip the real-module checks: %s not built (scripts/build-rs-net.sh)\n", beside.c_str());
    return g_failed == 0 ? 0 : 1;
  }
  error.clear();
  const grc_net_module_table_v1 *m = load_net_module(nullptr, &error);
  check(m != nullptr, "the real module loads (" + error + ")");
  if (m == nullptr) return 1;
  check(m->carrier_abi_version == GRC_CARRIER_ABI_VERSION && m->module_version != nullptr &&
            starts_with(m->module_version, "render-stream-net "),
        std::string("its table: carrier ABI 1, version ") + (m->module_version ? m->module_version : "?"));
  check(load_net_module(nullptr, &error) == m, "loaded once (cached)");

  char dir_template[] = "/tmp/rs-net-module-test-XXXXXX";
  const char *dir = mkdtemp(dir_template);
  check(dir != nullptr, "an evidence dir");
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
  if (wt == nullptr) return 1;
  NetWtCarrier *raw = wt.get();
  check(set.add(kCarrierWt, std::move(wt), &error), "added as index 1 (" + error + ")");
  check(set.start(&error), "started (" + error + ")");
  const std::string json = set.carriers_json();
  std::printf("%s\n", json.c_str());
  const CarrierInfo info = raw->info();
  check(info.transport == "udp" && info.port > 0 && info.address == "127.0.0.1",
        "bound udp 127.0.0.1:" + std::to_string(info.port));
  check(info.tls == "self-signed" && info.cert_sha256.size() == 64, "self-signed, sha256 " + info.cert_sha256);
  FILE *f = std::fopen((std::string(dir) + "/live-cert-sha256").c_str(), "r");
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
  std::remove((std::string(dir) + "/live-cert-sha256").c_str());
  rmdir(dir);
  return g_failed == 0 ? 0 : 1;
}
