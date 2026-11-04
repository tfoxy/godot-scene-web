// The late-arm registry's per-call cost (rs_registry.h, LAR0 registry-cost's microbench half).
// Measures, never judges: ns per tracked call for
//   off      the hook-side gate with GRC_ADOPT=off (registry_on() false: the pure path)
//   create   registry_note_create into a live set of `live` entries, uncontended
//   free     registry_note_free of those entries
//   pair4    create+free pairs from 4 threads at once (lock contention; per pair, wall / pairs)
//   bytes_per_entry  the registry's bytes_estimate / entries with `live` textures registered
// Usage: rs_registry_bench [live=20000] [rounds=50]
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

#include "rs_registry.h"

namespace {

std::uint64_t now_ns() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now().time_since_epoch())
                                        .count());
}

// The hook-side shape (hooks.cpp registry_create).
void tap_create(std::uint64_t rid) {
  if (grc::rs::registry_on()) {
    grc::rs::registry_note_create(rid, grc::rs::RegistryKind::Texture2d);
  }
}

}  // namespace

int main(int argc, char **argv) {
  using namespace grc::rs;
  const std::uint64_t live = argc > 1 ? std::strtoull(argv[1], nullptr, 10) : 20000;
  const int rounds = argc > 2 ? std::atoi(argv[2]) : 50;
  std::uint64_t node_bytes = 0;
  double best_off = 1e30, best_create = 1e30, best_free = 1e30, best_pair4 = 1e30;
  for (int r = 0; r < rounds; ++r) {
    registry_configure(false, RegistryFault::None);
    std::uint64_t t0 = now_ns();
    for (std::uint64_t i = 1; i <= live; ++i) {
      tap_create((std::uint64_t{1} << 32) | i);
    }
    std::atomic_signal_fence(std::memory_order_seq_cst);
    best_off = std::min(best_off, double(now_ns() - t0) / double(live));

    registry_configure(true, RegistryFault::None);
    t0 = now_ns();
    for (std::uint64_t i = 1; i <= live; ++i) {
      tap_create((std::uint64_t{1} << 32) | i);
    }
    best_create = std::min(best_create, double(now_ns() - t0) / double(live));
    const RegistryStats full = registry_stats();
    node_bytes = full.bytes_estimate / (full.entries != 0 ? full.entries : 1);
    t0 = now_ns();
    for (std::uint64_t i = 1; i <= live; ++i) {
      registry_note_free((std::uint64_t{1} << 32) | i);
    }
    best_free = std::min(best_free, double(now_ns() - t0) / double(live));

    registry_configure(true, RegistryFault::None);
    constexpr int kThreads = 4;
    std::vector<std::thread> threads;
    t0 = now_ns();
    for (int t = 0; t < kThreads; ++t) {
      threads.emplace_back([t, live] {
        const std::uint64_t base = (static_cast<std::uint64_t>(t) + 1) << 40;
        for (std::uint64_t i = 1; i <= live / kThreads; ++i) {
          registry_note_create(base + i, RegistryKind::Material);
          registry_note_free(base + i);
        }
      });
    }
    for (std::thread &th : threads) {
      th.join();
    }
    best_pair4 = std::min(best_pair4, double(now_ns() - t0) / double(live));
  }
  std::printf(
      "{\"schema\":\"render-stream-registry-bench/1\",\"live\":%llu,\"rounds\":%d,"
      "\"off_ns\":%.2f,\"create_ns\":%.2f,\"free_ns\":%.2f,\"pair4_ns\":%.2f,"
      "\"bytes_per_entry\":%llu}\n",
      static_cast<unsigned long long>(live), rounds, best_off, best_create, best_free, best_pair4,
      static_cast<unsigned long long>(node_bytes));
  return 0;
}
