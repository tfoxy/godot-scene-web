#include "calib.h"
#include "iface.h"

#include <cstdio>

namespace {
int checks = 0, failures = 0, version_calls = 0;
void check(bool ok, const char *name) {
  ++checks;
  if (!ok) {
    ++failures;
    std::fprintf(stderr, "FAIL Darwin fingerprint: %s\n", name);
  }
}
void version(GDExtensionGodotVersion2 *) { ++version_calls; }
} // namespace

int main() {
  grc::g_iface.get_godot_version2 = version;
  for (bool through_engine : {false, true}) {
    grc::ProcessFingerprint fp;
    fp.exe_sha256 = "stale identity";
    fp.exec_ranges.emplace_back(0, UINT64_MAX);
    fp.exe_maps.emplace_back("stale mapping");
    fp.version_string = "stale version";
    std::string error = "stale error";
    const bool collected = through_engine ? grc::collect_fingerprint(&fp, &error)
                                         : grc::collect_engine_fingerprint(&fp, &error);
    check(!collected, "collection refuses arming");
    check(error == "darwin-fingerprint-unsupported: Mach-O process identity is unavailable",
          "named refusal reaches caller");
#if defined(__aarch64__)
    check(fp.platform == "macos-arm64", "arm64 platform");
#else
    check(fp.platform == "macos-x86_64", "x86_64 platform");
#endif
    check(fp.exe_sha256.empty() && fp.image_sha256.empty() && fp.exe_maps.empty() &&
              fp.exec_ranges.empty() && fp.version_string.empty(), "stale identity cleared");
    check(version_calls == 0, "no engine call after fingerprint refusal");
  }
  std::printf("calib_fingerprint_darwin_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
