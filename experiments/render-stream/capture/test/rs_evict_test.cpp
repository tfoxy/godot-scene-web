#include "rs_platform.h"
#include "rs_evict.h"
#include "rs_json_lite.h"
#include "rs_texture_release.h"
#include "report.h"

#include <array>
#include <cstdio>
#include <thread>

namespace {
using namespace grc::rs;
using json_lite::JValue;
int checks = 0, failures = 0;
void expect(bool ok, int line) {
  ++checks;
  if (!ok) { std::fprintf(stderr, "FAIL rs_evict_test.cpp:%d\n", line); ++failures; }
}
#define EXPECT(ok) expect((ok), __LINE__)
const JValue &field(const JValue &v, const char *key) {
  static const JValue missing;
  const auto *p = v.get(key);
  EXPECT(p != nullptr);
  return p ? *p : missing;
}
void predicates() {
  EXPECT(evict_path_is_ctex("res://.godot/imported/a.png-0123.ctex"));
  for (const char *p : {"res://a.png", "x.ctexarray", "a.CTEX", ""}) EXPECT(!evict_path_is_ctex(p));
  // Exhaust all record flags, including precedence when several checks fail.
  for (unsigned bits = 0; bits < 256; ++bits) {
    for (const auto fmt : {-1, 0, 16, 17, 38, 39}) {
      EvictRecordInput in;
      in.registered = bits & 1; in.texture2d = bits & 2; in.released = bits & 4;
      in.facts_known = bits & 8; in.edited = bits & 16; in.path_valid = bits & 32;
      in.streaming = bits & 64; in.mirror_known = bits & 128; in.format = fmt;
      EvictSkip want = EvictSkip::None;
      if (!in.registered) want = EvictSkip::Unregistered;
      else if (!in.texture2d) want = EvictSkip::NotTexture2d;
      else if (in.released) want = EvictSkip::AlreadyReleased;
      else if (!in.facts_known || fmt < 17 || fmt > 38) want = EvictSkip::Format;
      else if (in.edited) want = EvictSkip::Edited;
      else if (!in.path_valid) want = EvictSkip::NoPath;
      else if (in.streaming && !in.mirror_known) want = EvictSkip::ArmedUnheld;
      EXPECT(evict_record_decision(in) == want);
    }
  }
  EvictImageInput ok;
  ok.image = true; ok.width = ok.rec_width = 64; ok.height = ok.rec_height = 64;
  ok.format = ok.rec_format = 19; ok.data_bytes = 4096;
  EXPECT(evict_image_decision(ok) == EvictSkip::None);
  auto in = ok; in.image = false; in.width = in.height = 1; in.format = 0;
  EXPECT(evict_image_decision(in) == EvictSkip::NoImage);
  in.image = true; EXPECT(evict_image_decision(in) == EvictSkip::AlreadyShrunk);
  in.mipmaps = true; EXPECT(evict_image_decision(in) == EvictSkip::Mismatch);
  for (int i = 0; i < 4; ++i) {
    in = ok;
    if (i == 0) ++in.width;
    if (i == 1) ++in.height;
    if (i == 2) ++in.format;
    if (i == 3) in.mipmaps = true;
    in.data_bytes = 4095;
    EXPECT(evict_image_decision(in) == EvictSkip::Mismatch);
  }
  in = ok; in.data_bytes = 4095; EXPECT(evict_image_decision(in) == EvictSkip::BelowMin);
  in.data_bytes = -1; EXPECT(evict_image_decision(in) == EvictSkip::BelowMin);
  in.data_bytes = 4096; EXPECT(evict_image_decision(in) == EvictSkip::None);
}
void pending(const EvictQueue &q) {
  EXPECT(detail::g_evict_pending.load(std::memory_order_relaxed) == q.counts().pending);
  EXPECT(evict_pending() == (q.counts().pending != 0));
}
void queues() {
  auto &q = evict_queue(); q.reset(); pending(q);
  std::vector<EvictEntry> out{{999, 999}};
  EXPECT(q.take(32, &out) == 0 && out.empty()); pending(q);
  EXPECT(q.note(1, 10)); pending(q); EXPECT(q.note(2, 11)); pending(q);
  EXPECT(q.take(1, &out) == 1 && out[0].rid == 1 && out[0].frame == 10); pending(q);
  q.park(out[0]); pending(q);
  EXPECT(q.counts().parked == 1);
  EXPECT(q.unpark_all() == 1); pending(q);
  EXPECT(q.counts().requeued == 1 && q.counts().parked == 0);
  EXPECT(q.take(0, &out) == 0 && out.empty()); pending(q);
  EXPECT(q.take(32, &out) == 2 && out[0].rid == 2 && out[1].rid == 1); pending(q);
  EXPECT(q.unpark_all() == 0); pending(q);
  q.reset(); pending(q);
  for (std::size_t i = 0; i < kEvictQueueCap; ++i) { EXPECT(q.note(i, 1)); pending(q); }
  EXPECT(!q.note(999, 1)); pending(q);
  EXPECT(q.counts().noted == kEvictQueueCap + 1 && q.counts().queue_dropped == 1);
  EXPECT(q.counts().queued == kEvictQueueCap);
  q.reset(); pending(q);
  EXPECT(q.counts().noted == 0 && q.counts().requeued == 0 && q.counts().parked == 0);
  // Unique IDs detect both lost and duplicate entries under concurrent hook notes.
  constexpr std::size_t total = 40000;
  std::array<std::thread, 4> threads;
  std::atomic<unsigned> done{0};
  std::atomic<bool> go{false};
  for (std::size_t t = 0; t < threads.size(); ++t) threads[t] = std::thread([&, t] {
    while (!go.load(std::memory_order_acquire)) std::this_thread::yield();
    for (std::size_t i = 0; i < 10000; ++i) q.note(t * 10000 + i, t);
    done.fetch_add(1, std::memory_order_release);
  });
  std::vector<unsigned> seen(total);
  std::size_t taken = 0;
  go.store(true, std::memory_order_release);
  while (done.load(std::memory_order_acquire) != 4 || evict_pending()) {
    q.take(kEvictDrainPerFrame, &out);
    for (const auto &e : out) {
      EXPECT(e.rid < total);
      if (e.rid < total) ++seen[e.rid];
      ++taken;
    }
    if (out.empty()) std::this_thread::yield();
  }
  for (auto &t : threads) t.join();
  pending(q);
  EXPECT(taken == total);
  for (const auto n : seen) EXPECT(n == 1);
  auto c = q.counts(); EXPECT(c.noted == total && c.noted == c.queued + c.queue_dropped);
  EXPECT(c.pending == 0 && c.queue_dropped == 0);
  q.reset(); pending(q);
}
void accounting() {
  EvictStats ok;
  ok.queue = {10, 9, 1, 2, 3, 1};
  ok.examined = 8; ok.released = 4;
  ok.skipped[static_cast<std::size_t>(EvictSkip::ArmedUnheld)] = 3;
  ok.skipped[static_cast<std::size_t>(EvictSkip::Format)] = 1;
  EXPECT(evict_balanced(ok));
  auto s = ok; ++s.released; EXPECT(!evict_balanced(s));
  s = ok; ++s.queue.pending; EXPECT(!evict_balanced(s));
  s = ok; ++s.queue.parked; EXPECT(!evict_balanced(s));
  s = ok; ++s.queue.noted; EXPECT(!evict_balanced(s));
  EXPECT(evict_balanced(EvictStats{}));
  texture_release_configure(kReleaseActive | kReleaseTimed);
  evict_queue().note(1, 1); evict_stats().released = 3;
  evict_configure(true, true, "active", "");
  EXPECT(evict_stats().configured && evict_stats().rss_test && evict_stats().released == 0);
  EXPECT(evict_stats().state == "active" && evict_stats().reason.empty());
  EXPECT(evict_queue().counts().noted == 0 && !evict_pending());
  EXPECT(texture_release_flags() == (kReleaseActive | kReleaseTimed | kReleaseEvict));
  evict_configure(false, false, "ignored", "registry-off");
  EXPECT(texture_release_flags() == (kReleaseActive | kReleaseTimed));
  EXPECT(evict_stats().state == "ignored" && evict_stats().reason == "registry-off");
  EXPECT(!evict_stats().rss_test);
}
void evidence() {
  EvictStats s;
  JValue v;
  const auto parse = [&] { v = JValue{};
    const auto text = evict_json(s, true, 42, 1234, {"rss_anon_bytes", 5678});
    EXPECT(json_lite::Reader(text).parse(&v)); };
  parse();
  EXPECT(field(v, "schema").text == "render-stream-evict/1");
  EXPECT(field(v, "final").b && field(v, "frame").text == "42");
  EXPECT(field(v, "rss_test").kind == JValue::Null && field(v, "reason").kind == JValue::Null);
  EXPECT(field(v, "min_bytes").text == "4096" && field(v, "per_frame").text == "32");
  EXPECT(field(v, "rss_bytes").text == "1234" && field(v, "rss_anon_bytes").text == "5678");
  for (const char *key : {"state", "noted", "queued", "queue_dropped", "requeued", "pending", "parked",
       "examined", "released", "released_bytes", "released_armed", "drains", "drain_us_total",
       "drain_us_max", "lifetime_frames_max", "evict_balanced", "releases", "releases_dropped"})
    EXPECT(v.get(key) != nullptr);
  const char *names[] = {"unregistered", "not_texture2d", "already_released", "format", "edited", "no_path",
      "armed_unheld", "no_image", "already_shrunk", "mismatch", "below_min", "freed_during", "shrink_failed"};
  for (unsigned i = 0; i < 13; ++i) {
    EXPECT(std::string(evict_skip_name(static_cast<EvictSkip>(i + 1))) == names[i]);
    EXPECT(field(field(v, "skipped"), names[i]).text == "0");
  }
  s.rss_test = true; s.rss_batches = 2; s.rss_measured_bytes = 8192; s.rss_freed_bytes = 9000;
  s.state = "active"; s.reason = "registry-off";
  EvictRelease r;
  r.rid = 99; r.frame = 8; r.queued_frame = 7; r.format = 19; r.width = r.height = 64;
  r.data_bytes = 4096; r.mipmaps = true; r.armed = true; r.path = "res://a\"b.ctex";
  s.releases.assign(kEvictReleaseRecordCap + 1, r); s.releases_dropped = 3;
  parse();
  EXPECT(field(v, "reason").text == "registry-off");
  EXPECT(field(v, "releases").items.size() == kEvictReleaseRecordCap);
  EXPECT(field(v, "releases_dropped").text == "4");
  const auto &rec = field(v, "releases").items.front();
  EXPECT(field(rec, "rid").text == "99" && field(rec, "frame").text == "8");
  EXPECT(field(rec, "queued_frame").text == "7" && field(rec, "format").text == "19");
  EXPECT(field(rec, "width").text == "64" && field(rec, "height").text == "64");
  EXPECT(field(rec, "data_bytes").text == "4096" && field(rec, "armed").b && field(rec, "mipmaps").b);
  EXPECT(field(rec, "path").text == r.path);
  const auto &rss = field(v, "rss_test");
  EXPECT(field(rss, "batches").text == "2" && field(rss, "measured_bytes").text == "8192");
  EXPECT(field(rss, "freed_bytes").text == "9000");
  grc::JsonWriter j; j.object_begin(); evict_fields(&j, s); j.object_end();
  const auto text = j.take(); v = JValue{}; EXPECT(json_lite::Reader(text).parse(&v));
  EXPECT(!v.get("schema") && !v.get("releases") && !v.get("rss_test"));
  const auto windows = evict_json(s, true, 42, 1234, {"private_bytes", 5678});
  v = JValue{}; EXPECT(json_lite::Reader(windows).parse(&v));
  EXPECT(field(v, "private_bytes").text == "5678" && !v.get("rss_anon_bytes"));
  EXPECT(anon_reading().bytes > 0);
}
}  // namespace
int main() {
  predicates(); queues(); accounting(); evidence();
  std::printf("rs_evict: %d checks, %d failures\n", checks, failures);
  return failures != 0;
}
