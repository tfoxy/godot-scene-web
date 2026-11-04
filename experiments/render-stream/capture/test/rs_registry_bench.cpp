// The late-arm registry's per-call cost (rs_registry.h, LAR0 registry-cost's microbench half).
// Measures, never judges: ns per tracked call for
//   off      the hook-side gate with GRC_ADOPT=off (registry_on() false: the pure path)
//   create   registry_note_create into a live set of `live` entries, uncontended
//   free     registry_note_free of those entries
//   pair4    create+free pairs from 4 threads at once (lock contention; per pair, wall / pairs)
//   bytes_per_entry  the registry's bytes_estimate / entries with `live` textures registered
//   ctex     LAR1: a CanvasTexture's registry life -- create, set_channel (diffuse),
//            set_texture_filter, the adoption's registry_canvas_texture read, free -- per call
//            (5 calls), uncontended, `live` CanvasTextures
//   mm       LAR2: a multimesh's registry life -- create, allocate_data, set_mesh, set_buffer, an
//            instance setter, the adoption's registry_multimesh read, free -- per call (7 calls),
//            uncontended, `live` multimeshes
//   mm_edit  LAR2: one instance setter's tap on a live multimesh (the per-instance hot path)
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
  double best_ctex = 1e30, best_mm = 1e30, best_mm_edit = 1e30;
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

    registry_configure(true, RegistryFault::None);
    RegistryCanvasTexture c;
    std::uint64_t sink = 0;
    t0 = now_ns();
    for (std::uint64_t i = 1; i <= live; ++i) {
      const std::uint64_t rid = (std::uint64_t{3} << 40) | i;
      registry_note_create(rid, RegistryKind::CanvasTexture);
      registry_note_canvas_channel(rid, 0, rid + 1);
      registry_note_canvas_filter(rid, 1);
    }
    for (std::uint64_t i = 1; i <= live; ++i) {
      const std::uint64_t rid = (std::uint64_t{3} << 40) | i;
      if (registry_canvas_texture(rid, &c)) sink += c.diffuse;
      registry_note_free(rid);
    }
    std::atomic_signal_fence(std::memory_order_seq_cst);
    best_ctex = std::min(best_ctex, double(now_ns() - t0) / double(live * 5));

    registry_configure(true, RegistryFault::None);
    RegistryMultimesh m;
    t0 = now_ns();
    for (std::uint64_t i = 1; i <= live; ++i) {
      const std::uint64_t rid = (std::uint64_t{4} << 40) | i;
      registry_note_create(rid, RegistryKind::Multimesh);
      registry_note_multimesh_allocate(rid, 16, 0, true, true, false);
      registry_note_multimesh_mesh(rid, rid + 1);
      registry_note_multimesh_buffer(rid, 16 * 16);
      registry_note_multimesh_instance_edit(rid);
    }
    for (std::uint64_t i = 1; i <= live; ++i) {
      const std::uint64_t rid = (std::uint64_t{4} << 40) | i;
      if (registry_multimesh(rid, &m)) sink += m.mesh;
      registry_note_free(rid);
    }
    std::atomic_signal_fence(std::memory_order_seq_cst);
    best_mm = std::min(best_mm, double(now_ns() - t0) / double(live * 7));
    const std::uint64_t one = (std::uint64_t{4} << 40) | 1;
    registry_note_create(one, RegistryKind::Multimesh);
    t0 = now_ns();
    for (std::uint64_t i = 1; i <= live; ++i) {
      registry_note_multimesh_instance_edit(one);
    }
    std::atomic_signal_fence(std::memory_order_seq_cst);
    best_mm_edit = std::min(best_mm_edit, double(now_ns() - t0) / double(live));
    if (sink == 1) {
      std::puts("");  // keeps the reads live
    }
  }
  std::printf(
      "{\"schema\":\"render-stream-registry-bench/1\",\"live\":%llu,\"rounds\":%d,"
      "\"off_ns\":%.2f,\"create_ns\":%.2f,\"free_ns\":%.2f,\"pair4_ns\":%.2f,"
      "\"bytes_per_entry\":%llu,\"ctex_ns\":%.2f,\"mm_ns\":%.2f,\"mm_edit_ns\":%.2f}\n",
      static_cast<unsigned long long>(live), rounds, best_off, best_create, best_free, best_pair4,
      static_cast<unsigned long long>(node_bytes), best_ctex, best_mm, best_mm_edit);
  return 0;
}
