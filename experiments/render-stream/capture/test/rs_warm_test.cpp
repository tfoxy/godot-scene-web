#include "rs_warm.h"

#include <array>
#include <chrono>
#include <cstdio>
#include <limits>
#include <thread>
#include <utility>

#include "rs_json_lite.h"

namespace {
using namespace grc::rs;
using json_lite::JValue;
int checks = 0, failures = 0;
void expect(bool ok, int line) {
  ++checks;
  if (!ok) { std::fprintf(stderr, "FAIL rs_warm_test.cpp:%d\n", line); ++failures; }
}
#define EXPECT(ok) expect((ok), __LINE__)
const JValue &field(const JValue &v, const char *key) {
  static const JValue missing;
  const auto *p = v.get(key);
  EXPECT(p != nullptr);
  return p ? *p : missing;
}
JValue json(const WarmStats &s) {
  JValue v;
  EXPECT(json_lite::Reader(warm_json(s)).parse(&v));
  return v;
}
void rules() {
  EXPECT(std::string(warm_source_name(WarmSource::Reload)) == "reload");
  EXPECT(std::string(warm_source_name(WarmSource::Registry)) == "registry");
  EXPECT(std::string(warm_source_name(WarmSource::Cache)) == "cache");
  EXPECT(std::string(warm_source_name(WarmSource::Hold)) == "hold");
  // Exhaust all inputs, including precedence when several rules apply.
  for (unsigned bits = 0; bits < 2048; ++bits) {
    WarmClassInput in;
    in.registered = bits & 1;
    in.texture2d = bits & 2;
    in.updated = bits & 4;
    in.released = bits & 8;
    in.has_reload_source = bits & 16;
    in.census_built = bits & 32;
    in.census_compressed = bits & 64;
    in.mirror_known = bits & 128;
    in.refused = bits & 256;
    in.reload_off = bits & 512;
    in.held = bits & 1024;
    WarmSkip expected = WarmSkip::None;
    WarmSource source = WarmSource::Cache, wanted = source;
    if (in.mirror_known) expected = WarmSkip::MirrorKnown;
    else if (in.refused) expected = WarmSkip::Refused;
    else if (in.held) wanted = WarmSource::Hold;
    else if (in.has_reload_source) wanted = WarmSource::Reload;
    else if (!in.texture2d) expected = WarmSkip::NotTexture2d;
    else if (in.released && !in.reload_off) expected = WarmSkip::Released;
    else if (!in.updated) wanted = WarmSource::Registry;
    else if (in.census_built && in.census_compressed) wanted = WarmSource::Cache;
    else expected = WarmSkip::Updated;
    EXPECT(warm_class(in, &source) == expected);
    EXPECT(source == wanted);
  }
  // Only these three combinations lack both a hold and a source prepared at the arm.
  for (unsigned bits = 0; bits < 32; ++bits) {
    const bool eligible = bits != 0 && bits != 4 && bits != 8;
    EXPECT(warm_eligible_at_reference(bits & 1, bits & 2, bits & 4, bits & 8, bits & 16) == eligible);
    if (bits < 16)
      EXPECT(warm_eligible_at_reference(bits & 1, bits & 2, bits & 4, bits & 8) == eligible);
  }
  WarmEntry entry;
  EXPECT(entry.hold_seq == 0);
  entry = {WarmSource::Hold, true, WarmBody(), 42};
  EXPECT(entry.source == WarmSource::Hold && entry.updated_at_warm && entry.hold_seq == 42);
  for (unsigned bits = 0; bits < 8; ++bits)
    EXPECT(warm_stale(bits & 1, bits & 2, bits & 4) == (bits == 6));
}
void claims() {
  WarmClaim claimed;
  EXPECT(claimed.state() == WarmClaim::kQueued);
  EXPECT(claimed.claim());
  EXPECT(claimed.state() == WarmClaim::kRunning);
  EXPECT(!claimed.claim() && !claimed.cancel());
  WarmClaim cancelled;
  EXPECT(cancelled.cancel());
  EXPECT(cancelled.state() == WarmClaim::kCancelled);
  EXPECT(!cancelled.cancel() && !cancelled.claim());
  for (int round = 0; round < 1000; ++round) {
    WarmClaim claim;
    std::atomic<int> ready{0}, winners{0};
    std::atomic<bool> go{false};
    std::array<std::thread, 8> threads;
    for (auto &t : threads) t = std::thread([&] {
      ready.fetch_add(1);
      while (!go.load(std::memory_order_acquire)) std::this_thread::yield();
      if (claim.claim()) winners.fetch_add(1);
    });
    while (ready.load() != 8) std::this_thread::yield();
    go.store(true, std::memory_order_release);
    for (auto &t : threads) t.join();
    EXPECT(winners.load() == 1);
    EXPECT(claim.state() == WarmClaim::kRunning);
    EXPECT(!claim.cancel());
  }
}
// Exercise the same claim-and-delay path used by the engine's warm task.
void task_delay() {
  struct Task : WarmTaskBase {
    void run() override {}
    void drop_source() override {}
  } task, cancelled, immediate;
  const auto t0 = std::chrono::steady_clock::now();
  EXPECT(task.claim_and_delay(25));
  EXPECT(std::chrono::steady_clock::now() - t0 >= std::chrono::milliseconds(20));
  EXPECT(task.claim.state() == WarmClaim::kRunning);
  auto begin = std::chrono::steady_clock::now();
  EXPECT(!task.claim_and_delay(300));
  EXPECT(std::chrono::steady_clock::now() - begin < std::chrono::milliseconds(200));
  EXPECT(cancelled.claim.cancel());
  begin = std::chrono::steady_clock::now();
  EXPECT(!cancelled.claim_and_delay(300));
  EXPECT(std::chrono::steady_clock::now() - begin < std::chrono::milliseconds(200));
  EXPECT(immediate.claim_and_delay(0));
}
PayloadPtr bytes(std::size_t size) { return std::make_shared<PayloadBytes>(size, 0); }
void bodies() {
  WarmBody b;
  EXPECT(b.coded_bytes() == 0);
  b.bytes = bytes(11);
  EXPECT(b.coded_bytes() == 11);
  b.copy.block_bytes = bytes(7);
  EXPECT(b.coded_bytes() == 18);
  b.bytes.reset();
  EXPECT(b.coded_bytes() == 7);
  b.job = std::make_shared<TextureJob>(b.copy);
  EXPECT(b.coded_bytes() == 0);
  PayloadCopy actual;
  actual.status = "ok";
  actual.block_bytes = bytes(5);
  b.job->finish(actual, bytes(13));
  EXPECT(b.coded_bytes() == 18);
  b.job = std::make_shared<TextureJob>(PayloadCopy());
  b.job->finish(PayloadCopy(), nullptr);
  EXPECT(b.coded_bytes() == 0);
  b.job = std::make_shared<TextureJob>(actual);
  b.job->finish(actual, nullptr);
  EXPECT(b.coded_bytes() == 5);
  auto coded = std::make_shared<PayloadBytes>(3, 0);
  coded->rest = RestCoding::Zstd;
  coded->identity_bytes = 100;
  b.job.reset();
  b.copy.block_bytes.reset();
  b.bytes = coded;
  EXPECT(b.coded_bytes() == 3);
}
void balance() {
  WarmStats s;
  EXPECT(warm_balanced(s));
  s.queued = 21;
  s.served = 1; s.discarded_stale = 2; s.discarded_freed = 3;
  s.discarded_superseded = 4; s.dropped_unreferenced = 5; s.held_entries = 6;
  EXPECT(warm_balanced(s));
  std::uint64_t WarmStats::*terms[] = {
      &WarmStats::queued, &WarmStats::served, &WarmStats::discarded_stale,
      &WarmStats::discarded_freed, &WarmStats::discarded_superseded,
      &WarmStats::dropped_unreferenced, &WarmStats::held_entries};
  for (auto term : terms) {
    auto bad = s;
    ++(bad.*term);
    EXPECT(!warm_balanced(bad));
  }
  s.final = true;
  EXPECT(!warm_balanced(s));
  s.queued -= s.held_entries; s.held_entries = 0;
  EXPECT(warm_balanced(s));
  s.held_entries = 1;
  EXPECT(!warm_balanced(s));
}
void evidence() {
  WarmStats s;
  auto v = json(s);
  EXPECT(field(v, "schema").text == "render-stream-warm/1");
  EXPECT(field(v, "skipped").kind == JValue::Null);
  EXPECT(field(v, "arm_to_warm_complete_ms").kind == JValue::Null);
  for (const char *name : {"final", "census_at_warm", "warm_balanced", "warm_complete"})
    EXPECT(field(v, name).kind == JValue::Bool && !field(v, name).b);
  for (const char *name : {"arm_index", "frame", "held_at_arm", "held_bytes_at_arm", "hold_dropped_fault",
       "queued", "from_hold", "from_reload", "from_registry", "from_cache",
       "jobs", "sync_coded", "not_ok", "from_reload_bytes", "reload_sources_left", "completed",
       "cancelled_freed", "cancelled_disarm", "promoted", "mispredicts", "served", "served_in_flight",
       "served_reload", "served_hold", "lazy_from_hold", "discarded_stale", "discarded_freed",
       "discarded_superseded", "dropped_unreferenced",
       "held_entries", "decode_at_reference", "warm_cache_bytes", "warm_queue_us", "warm_work_us",
       "reload_us", "census_us"}) EXPECT(field(v, name).text == "0");
  EXPECT(field(v, "arm_to_warm_queued_ms").text == "0.000");
  const auto &textures = field(v, "textures");
  for (const char *name : {"adopted", "current", "creation", "refused", "refused_no_image"})
    EXPECT(field(textures, name).text == "0");
  const auto &scanned = field(v, "scanned");
  for (const char *name : {"registered_2d", "mirror_known", "refused"}) EXPECT(field(scanned, name).text == "0");
  const auto &skipped = field(v, "skipped_by");
  for (const char *name : {"not_texture2d", "released", "updated", "evicted", "no_image"}) EXPECT(field(skipped, name).text == "0");
  const auto &lazy = field(v, "lazy_at_reference");
  EXPECT(field(lazy, "updated").text == "0" && field(lazy, "unregistered").text == "0");
  EXPECT(field(v, "decode_at_reference_rids").items.empty());
  const std::pair<const char *, std::uint64_t WarmStats::*> counts[] = {
      {"arm_index", &WarmStats::arm_index},
      {"frame", &WarmStats::frame},
      {"held_at_arm", &WarmStats::held_at_arm},
      {"held_bytes_at_arm", &WarmStats::held_bytes_at_arm},
      {"hold_dropped_fault", &WarmStats::hold_dropped_fault},
      {"from_hold", &WarmStats::from_hold},
      {"served_hold", &WarmStats::served_hold},
      {"lazy_from_hold", &WarmStats::lazy_from_hold},
      {"queued", &WarmStats::queued},
      {"from_reload", &WarmStats::from_reload},
      {"from_registry", &WarmStats::from_registry},
      {"from_cache", &WarmStats::from_cache},
      {"jobs", &WarmStats::jobs},
      {"sync_coded", &WarmStats::sync_coded},
      {"not_ok", &WarmStats::not_ok},
      {"from_reload_bytes", &WarmStats::from_reload_bytes},
      {"reload_sources_left", &WarmStats::reload_sources_left},
      {"completed", &WarmStats::completed},
      {"cancelled_freed", &WarmStats::cancelled_freed},
      {"cancelled_disarm", &WarmStats::cancelled_disarm},
      {"promoted", &WarmStats::promoted},
      {"mispredicts", &WarmStats::mispredicts},
      {"served", &WarmStats::served},
      {"served_in_flight", &WarmStats::served_in_flight},
      {"served_reload", &WarmStats::served_reload},
      {"discarded_stale", &WarmStats::discarded_stale},
      {"discarded_freed", &WarmStats::discarded_freed},
      {"discarded_superseded", &WarmStats::discarded_superseded},
      {"dropped_unreferenced", &WarmStats::dropped_unreferenced},
      {"held_entries", &WarmStats::held_entries},
      {"decode_at_reference", &WarmStats::decode_at_reference},
      {"warm_cache_bytes", &WarmStats::warm_cache_bytes},
      {"warm_queue_us", &WarmStats::warm_queue_us},
      {"warm_work_us", &WarmStats::warm_work_us},
      {"reload_us", &WarmStats::reload_us},
      {"census_us", &WarmStats::census_us},
  };
  std::uint64_t n = 1;
  for (const auto &entry : counts) s.*entry.second = n++;
  s.scanned = {31, 32, 33, 41};
  s.skipped_by = {34, 35, 36, 37, 38};
  s.lazy_at_reference = {39, 40};
  s.textures = {51, 52, 53, 54, 55};
  v = json(s);
  n = 1;
  for (const auto &entry : counts) EXPECT(field(v, entry.first).text == std::to_string(n++));
  EXPECT(field(field(v, "scanned"), "registered_2d").text == "31");
  EXPECT(field(field(v, "scanned"), "mirror_known").text == "32");
  EXPECT(field(field(v, "scanned"), "refused").text == "33");
  EXPECT(field(field(v, "scanned"), "census_unregistered").text == "41");
  n = 34;
  for (const char *key : {"not_texture2d", "released", "updated", "evicted", "no_image"})
    EXPECT(field(field(v, "skipped_by"), key).text == std::to_string(n++));
  EXPECT(field(field(v, "lazy_at_reference"), "updated").text == "39");
  EXPECT(field(field(v, "lazy_at_reference"), "unregistered").text == "40");
  n = 51;
  for (const char *key : {"adopted", "current", "creation", "refused", "refused_no_image"})
    EXPECT(field(field(v, "textures"), key).text == std::to_string(n++));
  s.final = s.warm_complete = s.warm_balanced = s.census_at_warm = true;
  s.arm_to_warm_complete_ms = 12.3456;
  s.arm_to_warm_queued_ms = 1.2344;
  s.fault = "quote\"\\\n"; s.skipped = "fault-warm-off"; s.workers = "2";
  s.decode_at_reference_rids.assign(34, std::numeric_limits<std::uint64_t>::max());
  v = json(s);
  for (const char *name : {"final", "census_at_warm", "warm_balanced", "warm_complete"})
    EXPECT(field(v, name).b);
  EXPECT(field(v, "fault").text == s.fault);
  EXPECT(field(v, "skipped").text == s.skipped);
  EXPECT(field(v, "workers").text == "2");
  EXPECT(field(v, "arm_to_warm_complete_ms").text == "12.346");
  EXPECT(field(v, "arm_to_warm_queued_ms").text == "1.234");
  const auto &rids = field(v, "decode_at_reference_rids").items;
  EXPECT(rids.size() == 32);
  for (const auto &rid : rids) EXPECT(rid.kind == JValue::String && rid.text == "18446744073709551615");
}
void counters() {
  auto &c = warm_counters();
  c.reset();
  std::array<std::thread, 4> threads;
  for (unsigned n = 0; n < threads.size(); ++n) threads[n] = std::thread([&, n] {
    for (unsigned i = 0; i < 1000; ++i) {
      const auto time = 1 + n * 1000 + i;
      c.note_done(time, 7, i % 2 == 0);
      c.note_cancel(time + 10000);
    }
  });
  for (auto &t : threads) t.join();
  EXPECT(c.done.load() == 4000 && c.cancelled.load() == 4000);
  EXPECT(c.mispredicts.load() == 2000 && c.work_ns.load() == 28000);
  EXPECT(c.last_finish_ns.load() == 14000);
  c.reset();
  EXPECT(c.done.load() == 0 && c.cancelled.load() == 0 && c.mispredicts.load() == 0);
  EXPECT(c.work_ns.load() == 0 && c.last_finish_ns.load() == 0);
  const auto t0 = warm_now_ns();
  EXPECT(t0 > 0 && warm_now_ns() >= t0);
}
}  // namespace
int main() {
  rules(); claims(); task_delay(); bodies(); balance(); evidence(); counters();
  std::printf("rs_warm_test: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
