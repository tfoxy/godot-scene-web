// G8sha: SHA-256 throughput microbench (not a ctest: it measures, it does not judge).
//
//   rs_sha256_bench [--path portable|sha-ni|default] [--json]
//   rs_sha256_bench --which    (prints the CPU's SHA-NI support and the default path, then exits)
//
// Hashes a 16 MiB buffer (the size of a 2048x2048 RGBA8 GRT1 payload, G8t's decode-cost texture)
// and small inputs from 64 B to 4 KiB (glyph atlas updates, mesh and shader payloads), each the
// best of several repeats, and prints MB/s (10^6 bytes per second) per size. With no --path it
// runs every path the CPU supports. Run it under the quiet lock's exclusive mode on a busy box.
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "rs_sha256.h"

#ifndef GRC_SHA256_BENCH_LEGACY
#define GRC_SHA256_HAS_PATHS 1
#endif

namespace {

// One sample: `iters` hashes of `size` bytes, best of `repeats`, in seconds per hash.
double best_seconds(const std::vector<std::uint8_t> &buf, std::size_t size, int iters,
                    int repeats, int path, std::uint8_t *sink) {
  double best = 1e30;
  for (int r = 0; r < repeats; ++r) {
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < iters; ++i) {
#ifdef GRC_SHA256_HAS_PATHS
      grc::Sha256 hash = path < 0 ? grc::Sha256() : grc::Sha256(static_cast<grc::Sha256Path>(path));
#else
      (void)path;
      grc::Sha256 hash;
#endif
      hash.update(buf.data(), size);
      const auto digest = hash.finish();
      *sink ^= digest[0];
    }
    const auto t1 = std::chrono::steady_clock::now();
    const double s = std::chrono::duration<double>(t1 - t0).count() / iters;
    if (s < best) {
      best = s;
    }
  }
  return best;
}

}  // namespace

int main(int argc, char **argv) {
  std::vector<int> paths;
  bool json = false;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--which") {
#ifdef GRC_SHA256_HAS_PATHS
      const bool ni = grc::sha256_path_available(grc::Sha256Path::sha_ni);
      std::printf("sha256 default path: %s (sha-ni %s)\n",
                  grc::sha256_path_name(grc::sha256_default_path()),
                  ni ? "available" : "not available");
#endif
      return 0;
    }
    if (arg == "--json") {
      json = true;
    } else if (arg == "--path" && i + 1 < argc) {
      const std::string name = argv[++i];
#ifdef GRC_SHA256_HAS_PATHS
      if (name == "default") {
        paths.push_back(-1);
      } else if (name == "portable") {
        paths.push_back(static_cast<int>(grc::Sha256Path::portable));
      } else if (name == "sha-ni") {
        if (!grc::sha256_path_available(grc::Sha256Path::sha_ni)) {
          std::fprintf(stderr, "rs_sha256_bench: sha-ni is not available on this CPU\n");
          return 2;
        }
        paths.push_back(static_cast<int>(grc::Sha256Path::sha_ni));
      } else {
        std::fprintf(stderr, "rs_sha256_bench: unknown path %s\n", name.c_str());
        return 2;
      }
#else
      (void)name;
      paths.push_back(-1);
#endif
    } else {
      std::fprintf(stderr,
                   "usage: rs_sha256_bench [--path portable|sha-ni|default] [--json] | --which\n");
      return 2;
    }
  }
  if (paths.empty()) {
#ifdef GRC_SHA256_HAS_PATHS
    paths.push_back(static_cast<int>(grc::Sha256Path::portable));
    if (grc::sha256_path_available(grc::Sha256Path::sha_ni)) {
      paths.push_back(static_cast<int>(grc::Sha256Path::sha_ni));
    }
#else
    paths.push_back(-1);
#endif
  }

  const std::size_t big = 16u << 20;
  std::vector<std::uint8_t> buf(big);
  std::uint32_t x = 0x9e3779b9u;
  for (auto &b : buf) {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    b = static_cast<std::uint8_t>(x);
  }
  const std::size_t sizes[] = {64, 256, 1024, 4096, big};
  std::uint8_t sink = 0;
  if (json) {
    std::printf("[");
  }
  bool first = true;
  for (int path : paths) {
#ifdef GRC_SHA256_HAS_PATHS
    const char *name = path < 0 ? grc::sha256_path_name(grc::sha256_default_path())
                                : grc::sha256_path_name(static_cast<grc::Sha256Path>(path));
#else
    const char *name = "legacy";
#endif
    for (std::size_t size : sizes) {
      const int iters = size == big ? 1 : static_cast<int>((64u << 20) / size / 8);
      const int repeats = size == big ? 9 : 7;
      const double s = best_seconds(buf, size, iters, repeats, path, &sink);
      const double mbps = static_cast<double>(size) / s / 1e6;
      if (json) {
        std::printf("%s{\"path\":\"%s\",\"bytes\":%zu,\"ns_per_hash\":%.1f,\"mb_per_s\":%.1f}",
                    first ? "" : ",", name, size, s * 1e9, mbps);
      } else {
        std::printf("%-8s %9zu B  %12.1f ns/hash  %8.1f MB/s\n", name, size, s * 1e9, mbps);
      }
      first = false;
    }
  }
  if (json) {
    std::printf("]\n");
  }
  return sink == 0xff ? 0 : 0;  // keep the digests live
}
