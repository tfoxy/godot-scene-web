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
// Usage: rs_registry_bench [live=20000] [rounds=50] | interleaved
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <cstring>
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

// Evict the registry's lines between calls; volatile stores keep the sweep observable.
void sweep(volatile std::uint8_t *buffer) {
  for (std::size_t i = 0; i < 1024 * 1024; i += 64) buffer[i] = 1;
}

double median(std::vector<double> values) {
  std::sort(values.begin(), values.end());
  return (values[(values.size() - 1) / 2] + values[values.size() / 2]) / 2;
}

int interleaved() {
  using namespace grc::rs;
  registry_configure(true, RegistryFault::None);
  std::deque<std::uint64_t> oldest;
  std::uint64_t next = 1;
  for (int i = 0; i < 5000; ++i) {
    const auto kind = i < 2000 ? RegistryKind::Mesh :
                      i < 3500 ? RegistryKind::Shader : RegistryKind::Material;
    registry_note_create(next, kind);
    oldest.push_back(next++);
  }
  registry_frame(0);
  const auto name = registry_name_intern(1, "bench", std::make_shared<int>(0));
  const RegistryValue value = std::make_shared<int>(1);
  std::vector<std::uint8_t> buffer(1024 * 1024);
  std::vector<double> creates, frees, params, drains, baselines;
  for (int frame = 1; frame <= 200; ++frame) {
    std::vector<double> empty;
    for (int i = 0; i < 104; ++i) {
      sweep(buffer.data());
      const auto start = now_ns();
      std::atomic_signal_fence(std::memory_order_seq_cst);
      empty.push_back(double(now_ns() - start));
    }
    const double baseline = median(empty);
    baselines.push_back(baseline);
    double create = 0, free = 0, param = 0;
    std::uint64_t material = 0;
    for (int i = 0; i < 16; ++i) {
      for (auto kind : {RegistryKind::Mesh, RegistryKind::Shader, RegistryKind::Material}) {
        const auto rid = next++;
        sweep(buffer.data());
        const auto start = now_ns();
        registry_note_create(rid, kind);
        create += double(now_ns() - start) - baseline;
        oldest.push_back(rid);
        if (kind == RegistryKind::Material) material = rid;
      }
    }
    for (int i = 0; i < 48; ++i) {
      const auto rid = oldest.front();
      oldest.pop_front();
      sweep(buffer.data());
      const auto start = now_ns();
      registry_note_free(rid);
      free += double(now_ns() - start) - baseline;
    }
    for (int i = 0; i < 8; ++i) {
      sweep(buffer.data());
      const auto start = now_ns();
      registry_note_material_param(material, name, value);
      param += double(now_ns() - start) - baseline;
    }
    sweep(buffer.data());
    const auto start = now_ns();
    registry_frame(frame);
    drains.push_back(double(now_ns() - start) - baseline);
    creates.push_back(create / 48);
    frees.push_back(free / 48);
    params.push_back(param / 8);
  }
  std::printf("interleaved live=5000 frames=200 create_ns/call=%.2f free_ns/call=%.2f "
              "param_ns/call=%.2f drain_ns/frame=%.2f baseline_ns/call=%.2f\n",
              median(creates), median(frees), median(params), median(drains), median(baselines));
  return 0;
}

}  // namespace

int main(int argc, char **argv) {
  using namespace grc::rs;
  if (argc > 1 && std::strcmp(argv[1], "interleaved") == 0) return interleaved();
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
