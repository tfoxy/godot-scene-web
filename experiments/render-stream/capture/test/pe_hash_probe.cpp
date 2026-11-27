#include "pe_image.h"
#include "rs_sha256.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
double ms(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
void samples(const char *key, std::array<double, 3> values, bool throughput = false) {
  std::printf("\"%s\":{\"runs\":[%.6f,%.6f,%.6f],", key, values[0], values[1], values[2]);
  std::sort(values.begin(), values.end());
  std::printf("\"best\":%.6f,\"median\":%.6f}", values[throughput ? 2 : 0], values[1]);
}
}
int main(int argc, char **argv) {
  if (argc != 2) { std::fprintf(stderr, "usage: pe_hash_probe <PE path>\n"); return 2; }
  std::vector<unsigned char> buffer(90u * 1024 * 1024, 0x5a);
  std::array<double, 3> portable{}, read{}, hash{};
  std::string digest, error;
  uint64_t bytes = 0, read_bytes = 0, base = 0;
  for (int i = 0; i < 3; ++i) {
    auto start = Clock::now();
    grc::Sha256 sha(grc::Sha256Path::portable);
    sha.update(buffer.data(), buffer.size());
    // Observable digest prevents an optimizing build from discarding the work.
    if (grc::sha256_hex(sha.finish()).empty()) return 1;
    portable[i] = (double(buffer.size()) / 1000000) / (ms(start) / 1000);
    start = Clock::now();
    if (!grc::pe_image_read_only(argv[1], &read_bytes, &error)) {
      std::fprintf(stderr, "%s\n", error.c_str()); return 1;
    }
    read[i] = ms(start);
    start = Clock::now();
    if (!grc::pe_image_sha256(argv[1], &digest, &bytes, &base, &error) || read_bytes != bytes) {
      std::fprintf(stderr, "%s\n", error.c_str()); return 1;
    }
    hash[i] = ms(start);
  }
  std::printf("{\"sha_ni\":%s,\"default_path\":\"%s\",",
      grc::sha256_path_available(grc::Sha256Path::sha_ni) ? "true" : "false",
      grc::sha256_path_name(grc::sha256_default_path()));
  samples("portable_mb_s", portable, true); std::printf(",");
  samples("read_only_ms", read); std::printf(",");
  samples("image_hash_ms", hash);
  std::printf(",\"bytes\":%llu,\"digest\":\"%s\"}\n", static_cast<unsigned long long>(bytes), digest.c_str());
}
