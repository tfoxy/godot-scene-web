#include "calib.h"
#include "macho_image.h"

#include <cstdio>
#include <cstdlib>

// File facts stand in for the running slice on a non-Darwin test host.
int main(int argc, char **argv) {
  if (argc != 4) return 2;
  grc::Calibration c;
  grc::MachoHeaders h;
  grc::ProcessFingerprint fp;
  std::string error;
  if (!grc::load_calibration(argv[2], &c, &error) ||
      !grc::macho_file_identity(argv[1], std::strtoul(argv[3], nullptr, 0),
                               &h, &fp.exe_sha256, &error)) {
    std::fprintf(stderr, "%s\n", error.c_str());
    return 2;
  }
  fp.uuid = h.uuid; fp.cputype = h.cputype; fp.cpusubtype = h.cpusubtype;
  fp.slice_offset = h.slice_offset; fp.slice_size = h.slice_size; fp.pie = h.pie;
  fp.platform = h.cputype == grc::macho_arm64 ? "macos-arm64" : "macos-x86_64";
  fp.version_string = "Godot Engine v4.5.1.stable.synthetic";
  std::vector<grc::CheckResult> checks;
  const bool ok = grc::check_fingerprint(c, fp, &checks);
  for (const auto &r : checks)
    std::printf("check %s %s %s\n", r.name.c_str(), r.ok ? "ok" : "FAIL", r.detail.c_str());
  if (!ok) std::puts("refused: fingerprint-mismatch");
  return ok ? 0 : 3;
}
