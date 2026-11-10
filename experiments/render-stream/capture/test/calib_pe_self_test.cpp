#include "calib.h"
#include "pe_image.h"
#include "rs_platform.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <regex>

namespace {
int total = 0, failed = 0;
void check(bool ok, const char *name) {
  ++total;
  if (!ok) { ++failed; std::fprintf(stderr, "FAIL %s\n", name); }
}
std::string field(const std::string &json, const char *key) {
  const std::regex pattern(std::string("\"") + key + "\"\\s*:\\s*(\"([^\"]*)\"|[0-9]+|true|false|null)");
  std::smatch match;
  if (!std::regex_search(json, match, pattern)) return "";
  return match[2].matched ? match[2].str() : match[1].str();
}
}
int main(int argc, char **argv) {
  using namespace grc;
  if (argc < 2 || argc > 3) return 2;
  const bool sabotage = argc == 3 && std::string(argv[2]) == "--expect-image-mismatch";
  std::ifstream input(rs::fs_path(argv[1]));
  const std::string json((std::istreambuf_iterator<char>(input)), {});
  Calibration c;
  c.platform = "windows-x86_64";
  c.image_sha256 = field(json, "image_sha256");
  c.codeview_id = field(json, "codeview_id"); c.codeview_id_present = true;
  c.image_base = std::strtoull(field(json, "image_base").c_str(), nullptr, 0);
  c.time_date_stamp = std::strtoll(field(json, "time_date_stamp").c_str(), nullptr, 10);
  c.size_of_image = std::strtoll(field(json, "size_of_image").c_str(), nullptr, 10);
  c.dynamic_base = field(json, "dynamic_base") == "true";
  c.version_string = "self-test";
  check(c.image_sha256.size() == 64 && !c.codeview_id.empty() && c.codeview_id != "null" &&
        c.image_base != 0 && c.size_of_image > 0 && c.dynamic_base, "identity JSON complete");
  ProcessFingerprint fp; std::string error;
  const bool collected = collect_engine_fingerprint(&fp, &error);
  check(collected, error.empty() ? "collect PE fingerprint" : error.c_str());
  if (!collected) return 1;
  std::string timed_hash; uint64_t timed_bytes = 0, timed_base = 0;
  const auto start = std::chrono::steady_clock::now();
  const bool hashed = pe_image_sha256(fp.exe_path, &timed_hash, &timed_bytes, &timed_base, &error);
  std::printf("image hash duration %.3f ms (%llu bytes)\n", std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - start).count(), static_cast<unsigned long long>(timed_bytes));
  check(hashed && timed_hash == fp.image_sha256 && timed_base == fp.image_base, "timed file hash agrees");
  fp.version_string = c.version_string;
  std::vector<CheckResult> checks;
  const bool ok = check_fingerprint(c, fp, &checks);
  check(ok == !sabotage && checks.size() == 5, "fingerprint group result");
  for (size_t i = 0; i < checks.size(); ++i) {
    const auto &r = checks[i];
    std::printf("check %s %s %s\n", r.name.c_str(), r.ok ? "ok" : "FAIL", r.detail.c_str());
    check(r.ok == !(sabotage && i == 0), r.name.c_str());
  }
  check(fp.dynamic_base && fp.platform == "windows-x86_64", "ASLR and platform");
  check(fp.in_exec_range(reinterpret_cast<uint64_t>(&main)), "main in executable section");
  std::ifstream binary(rs::fs_path(fp.exe_path), std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(binary)), {});
  PeHeaders h;
  check(pe_parse_headers(bytes.data(), bytes.size(), &h, &error), "file PE headers");
  check(fp.codeview_id == pe_codeview_id(bytes.data(), bytes.size(), h, false), "mapped and file CodeView agree");
  // Subtracting corresponding file and live addresses independently recovers the module base.
  uint64_t module_base = 0;
  for (const auto &s : h.sections) if (s.characteristics & 0x20000000) {
    module_base = fp.exec_ranges.front().first - s.va; break;
  }
  check(fp.load_bias == module_base - c.image_base, "bias uses preferred file base");
  check(fp.exe_maps.size() == h.sections.size() && fp.pid == static_cast<int>(rs::process_id()), "maps and pid");
  const std::string expected = sabotage ? "calib_pe_self_test-rdata-sabotage.exe" : "calib_pe_self_test.exe";
  check(fp.exe_path.ends_with(expected), "executable path suffix");
  std::printf("calib_pe_self_test: %d passed, %d failed\n", total - failed, failed);
  return failed ? 1 : 0;
}
