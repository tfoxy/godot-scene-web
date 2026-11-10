#include "calib.h"
#include "pe_image.h"
#include <cstdio>
#include <fstream>
#include <iterator>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  grc::Calibration c; std::string error;
  if (!grc::load_calibration(argv[2], &c, &error)) return 2;
  std::ifstream file(argv[1], std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)), {});
  grc::PeHeaders h;
  grc::ProcessFingerprint fp;
  uint64_t hashed_bytes = 0;
  if (!grc::pe_parse_headers(bytes.data(), bytes.size(), &h, &error) ||
      !grc::pe_image_sha256(argv[1], &fp.image_sha256, &hashed_bytes, &fp.image_base, &error)) return 2;
  fp.platform = "windows-x86_64";
  fp.version_string = "Godot Engine v4.5.1.stable.synthetic";
  fp.codeview_id = grc::pe_codeview_id(bytes.data(), bytes.size(), h, false);
  fp.time_date_stamp = h.time_date_stamp;
  fp.size_of_image = h.size_of_image;
  fp.dynamic_base = bool(h.dll_characteristics & 0x40);
  std::vector<grc::CheckResult> checks;
  const bool ok = grc::check_fingerprint(c, fp, &checks);
  for (const auto &r : checks)
    std::printf("check %s %s %s\n", r.name.c_str(), r.ok ? "ok" : "FAIL", r.detail.c_str());
  if (!ok) std::puts("refused: fingerprint-mismatch");
  return ok ? 0 : 3;
}
