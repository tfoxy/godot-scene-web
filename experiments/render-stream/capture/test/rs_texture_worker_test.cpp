// Unit tests for the texture worker pool and the publication hold-back (src/rs_texture_worker.*;
// texture-delivery-design.md D11, Q7; G8kw), with no engine: a fake "worker" fills each job with
// the bytes and hash the synchronous path would have produced. The engine half (the duplicate,
// Image::decompress on a worker) runs only inside Godot (run-gate8.sh g8t, the workers legs).
//
// The property under test: a mirror and a hook log fed predictions plus jobs resolve, once the
// jobs finish, to exactly what the synchronous copies give -- snapshot for snapshot (the full
// transaction's bytes), line for line -- and nothing that names a pending hash is published.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs_mirror.h"
#include "rs_resource_log.h"
#include "rs_sha256.h"
#include "rs_texture_payload.h"
#include "rs_texture_worker.h"

namespace {

using grc::rs::Captured;
using grc::rs::HeldSnapshot;
using grc::rs::HoldBack;
using grc::rs::Mirror;
using grc::rs::PayloadCopy;
using grc::rs::PayloadPtr;
using grc::rs::TextureJob;
using grc::rs::TextureJobPtr;
using grc::rs::TextureWorkerConfig;
using grc::rs::TextureWorkerPool;

int g_failures = 0;

void check(bool condition, const char *what) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what);
    ++g_failures;
  }
}

constexpr std::uint64_t kRootViewport = 0x1000;
constexpr std::uint64_t kRootCanvas = 0x2000;
constexpr grc::rs2::Xform kRootXform = {1, 0, 0, 1, 0, 0};
constexpr grc::rs2::Color4 kRed = {1, 0, 0, 1};
constexpr grc::rs2::Rect4 kRect = {0, 0, 96, 64};

// The synchronous path's copy of a w x h RGBA8 image filled with `value`.
PayloadCopy sync_copy(std::int64_t w, std::int64_t h, std::uint8_t value, PayloadPtr *bytes) {
  const std::vector<std::uint8_t> data(static_cast<std::size_t>(w * h * 4), value);
  PayloadCopy copy;
  copy.status = "ok";
  copy.format = 5;
  copy.width = w;
  copy.height = h;
  copy.mipmaps_known = true;
  copy.mipmaps = false;
  copy.data_bytes = static_cast<std::int64_t>(data.size());
  auto payload = std::make_shared<grc::rs::PayloadBytes>(
      grc::rs::encode_payload(5, w, h, false, data.data(), data.size()));
  copy.payload_bytes = static_cast<std::int64_t>(payload->size());
  copy.hash = grc::sha256_hex(payload->data(), payload->size());
  copy.copy_ns = 11;
  copy.hash_ns = 22;
  *bytes = payload;
  return copy;
}

// The hook's prediction of the same copy: every fact, no content.
PayloadCopy predicted(const PayloadCopy &sync) {
  PayloadCopy p = sync;
  p.hash.clear();
  p.copy_ns = -1;
  p.hash_ns = -1;
  p.worker = true;
  p.hook_ns = 5;
  p.dup_ns = 1;
  return p;
}

std::vector<std::uint8_t> full_bytes(const Captured &c) {
  return grc::rs2::encode_transaction(grc::rs2::make_full(c.state));
}

void drawing_item(Mirror *m, std::uint64_t item, std::uint64_t tex, std::uint64_t frame) {
  m->canvas_item_create(item, frame);
  m->set_parent(item, kRootCanvas, frame);
  m->set_draw_index(item, static_cast<std::int32_t>(item), frame);
  m->add_texture_rect(item, kRect, tex, false, kRed, false, frame);
}

// --- configuration -------------------------------------------------------------------------

void test_parse() {
  TextureWorkerConfig c;
  std::string error;
  check(grc::rs::parse_texture_workers(nullptr, nullptr, nullptr, nullptr, &c, &error) &&
            !c.async() && c.min_bytes == 65536 && c.delay_ms == 0 &&
            grc::rs::texture_workers_name(c) == "sync",
        "unset: sync, 64 KiB threshold");
  check(grc::rs::parse_texture_workers("sync", nullptr, nullptr, nullptr, &c, &error) && !c.async(),
        "sync");
  check(grc::rs::parse_texture_workers("2", "0", "30", nullptr, &c, &error) && c.workers == 2 &&
            c.min_bytes == 0 && c.delay_ms == 30 && grc::rs::texture_workers_name(c) == "2",
        "2 workers, every copy, 30 ms delay");
  check(grc::rs::parse_texture_workers("16", nullptr, nullptr, "publish-before-ready", &c, &error) &&
            c.fault_publish_before_ready,
        "the fault knob with workers");
  check(!grc::rs::parse_texture_workers("0", nullptr, nullptr, nullptr, &c, &error), "0 refused");
  check(!grc::rs::parse_texture_workers("17", nullptr, nullptr, nullptr, &c, &error), "17 refused");
  check(!grc::rs::parse_texture_workers("two", nullptr, nullptr, nullptr, &c, &error), "text refused");
  check(!grc::rs::parse_texture_workers("2", "-1", nullptr, nullptr, &c, &error), "negative refused");
  check(!grc::rs::parse_texture_workers("sync", nullptr, "5", nullptr, &c, &error),
        "a delay without workers is refused");
  check(!grc::rs::parse_texture_workers("sync", nullptr, nullptr, "publish-before-ready", &c,
                                        &error),
        "the fault without workers is refused");
  check(!grc::rs::parse_texture_workers("2", nullptr, nullptr, "other", &c, &error) &&
            error.find("GRC_TEXTURE_WORKER_FAULT") != std::string::npos,
        "an unknown fault is refused, named");
}

// --- the pool ------------------------------------------------------------------------------

void test_pool() {
  TextureWorkerPool pool;
  check(!pool.running() && !pool.submit([] {}), "a pool that never started refuses work");
  check(pool.start(3, 0) && pool.running() && !pool.start(2, 0), "start once");
  std::atomic<int> ran{0};
  std::atomic<int> peak{0};
  std::atomic<int> now{0};
  for (int i = 0; i < 40; ++i) {
    check(pool.submit([&] {
      const int in = ++now;
      int p = peak.load();
      while (in > p && !peak.compare_exchange_weak(p, in)) {
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      --now;
      ++ran;
    }),
          "submit while running");
  }
  pool.drain();
  check(ran.load() == 40, "drain waits for every queued job");
  check(peak.load() >= 2 && peak.load() <= 3, "jobs run in parallel, at most `workers` at a time");
  const TextureWorkerPool::Stats st = pool.stats();
  check(st.submitted == 40 && st.completed == 40 && st.max_queued >= 1, "stats count every job");
  // stop() drains first: work queued before it always runs; work after it is refused.
  for (int i = 0; i < 10; ++i) {
    pool.submit([&] {
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
      ++ran;
    });
  }
  pool.stop();
  check(ran.load() == 50 && !pool.running(), "stop drains the queue, then joins");
  check(!pool.submit([] {}), "a stopped pool refuses work (the caller copies inline)");
  pool.stop();  // idempotent
  // restartable, and the delay knob holds a job back
  check(pool.start(1, 40), "restart with a delay");
  auto job = std::make_shared<TextureJob>(PayloadCopy());
  const auto t0 = std::chrono::steady_clock::now();
  pool.submit([job] { job->finish(PayloadCopy(), nullptr); });
  job->wait();
  const auto waited = std::chrono::steady_clock::now() - t0;
  check(waited >= std::chrono::milliseconds(35), "GRC_TEXTURE_WORKER_DELAY_MS delays the result");
  pool.stop();
}

// A stop racing submits from other threads never loses a job: each is either run by the pool or
// refused (and then run by its caller).
void test_stop_race() {
  TextureWorkerPool pool;
  pool.start(2, 0);
  std::atomic<int> done{0};
  std::vector<std::thread> hooks;
  for (int t = 0; t < 4; ++t) {
    hooks.emplace_back([&] {
      for (int i = 0; i < 200; ++i) {
        if (!pool.submit([&] { ++done; })) {
          ++done;  // inline, as hooks.cpp falls back
        }
      }
    });
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
  pool.stop();
  for (std::thread &h : hooks) {
    h.join();
  }
  check(done.load() == 800, "every copy runs exactly once across a stop");
}

// --- the job --------------------------------------------------------------------------------

void test_job() {
  PayloadPtr bytes;
  const PayloadCopy sync = sync_copy(4, 4, 7, &bytes);
  TextureJob job(predicted(sync));
  check(!job.done(), "a new job is pending");
  job.finish(sync, bytes);
  check(job.done() && !job.mispredict() && job.bytes() == bytes, "finished as predicted");
  PayloadCopy filled = predicted(sync);
  job.fill(&filled);
  check(filled.hash == sync.hash && filled.copy_ns == 11 && filled.hash_ns == 22 && filled.worker,
        "fill takes the content and keeps the hook's own columns");

  TextureJob bad(predicted(sync));
  PayloadCopy refused = sync;
  refused.status = "unsupported";
  refused.reason = "unsupported-format";
  refused.hash.clear();
  bad.finish(refused, nullptr);
  check(bad.mispredict(), "a worker refusal the hook did not predict is a mispredict");
  TextureJob empty(predicted(sync));
  empty.finish(sync, nullptr);
  check(empty.mispredict(), "an ok copy without bytes is a mispredict");
}

// --- mirror + hold-back ------------------------------------------------------------------------

// One scripted session, applied to a mirror either synchronously or with predictions plus jobs.
struct Session {
  Mirror mirror;
  std::vector<TextureJobPtr> jobs;          // async only, in submission order
  std::vector<PayloadCopy> results;         // what each job's worker will deliver
  std::vector<PayloadPtr> result_bytes;
  bool async = false;

  void create(std::uint64_t rid, std::uint8_t value, std::uint64_t frame) {
    PayloadPtr bytes;
    const PayloadCopy sync = sync_copy(8, 8, value, &bytes);
    if (!async) {
      mirror.texture_2d_create(rid, sync, bytes, frame);
      return;
    }
    auto job = std::make_shared<TextureJob>(predicted(sync));
    mirror.texture_2d_create(rid, predicted(sync), nullptr, frame, job);
    jobs.push_back(job);
    results.push_back(sync);
    result_bytes.push_back(bytes);
  }
  void update(std::uint64_t rid, std::uint8_t value, std::uint64_t frame) {
    PayloadPtr bytes;
    const PayloadCopy sync = sync_copy(8, 8, value, &bytes);
    if (!async) {
      mirror.texture_2d_update(rid, sync, bytes, 0, frame);
      return;
    }
    auto job = std::make_shared<TextureJob>(predicted(sync));
    mirror.texture_2d_update(rid, predicted(sync), nullptr, 0, frame, job);
    jobs.push_back(job);
    results.push_back(sync);
    result_bytes.push_back(bytes);
  }
  void finish(std::size_t i) { jobs[i]->finish(results[i], result_bytes[i]); }
};

// frames 1..6: two textures drawn at 1, a third at 3, an update of the first at 4, a replace at 5.
void script(Session *s, std::uint64_t frame) {
  Mirror &m = s->mirror;
  switch (frame) {
    case 1:
      s->create(500, 10, 1);
      s->create(501, 20, 1);
      drawing_item(&m, 100, 500, 1);
      drawing_item(&m, 101, 501, 1);
      break;
    case 3:
      s->create(502, 30, 3);
      drawing_item(&m, 102, 502, 3);
      break;
    case 4:
      s->update(500, 40, 4);
      break;
    case 5:
      m.texture_replace(501, 502, 5);
      break;
    default:
      break;
  }
}

void test_holdback_equals_sync() {
  Session sync;
  sync.mirror.set_root(kRootViewport, kRootCanvas, kRootXform);
  Session async;
  async.async = true;
  async.mirror.set_root(kRootViewport, kRootCanvas, kRootXform);
  HoldBack hold;
  std::vector<std::vector<std::uint8_t>> sync_tx(7);
  std::vector<bool> published(7, false);
  // Jobs finish late: the frame-1 pair at frame 2's callback (one of them at frame 3's), the
  // frame-3 create at frame 6's, the update at frame 4's own.
  for (std::uint64_t frame = 1; frame <= 6; ++frame) {
    script(&sync, frame);
    script(&async, frame);
    if (frame == 2) async.finish(0);
    if (frame == 3) async.finish(1);
    if (frame == 4) async.finish(3);
    if (frame == 6) async.finish(2);
    Captured cs = sync.mirror.snapshot(frame, frame);
    sync_tx[frame] = full_bytes(cs);
    HeldSnapshot offered;
    offered.snapshot = async.mirror.snapshot(frame, frame);
    offered.frame = frame;
    HeldSnapshot ready;
    bool publish = false;
    std::string error;
    check(hold.offer(std::move(offered), frame, false, &ready, &publish, &error) && error.empty(),
          "offer");
    if (publish) {
      check(ready.snapshot.pending.empty(), "a published snapshot has nothing pending");
      // seq is the mirror's argument here, equal to the frame, so the bytes compare directly.
      check(full_bytes(ready.snapshot) == sync_tx[ready.frame],
            "a published async snapshot equals the synchronous snapshot of the same frame");
      if (ready.frame == frame) {
        bool same = ready.snapshot.payloads.size() == cs.payloads.size();
        for (const auto &e : cs.payloads) {
          const auto it = ready.snapshot.payloads.find(e.first);
          same = same && it != ready.snapshot.payloads.end() && *it->second == *e.second;
        }
        check(same, "same payload map as the synchronous snapshot");
      }
      published[ready.frame] = true;
    }
  }
  // Callback 3 publishes frame 2 (both frame-1 jobs done by then) while frame 3's own create is
  // pending; frames 3-5 wait for job 2, which frame 6's callback publishes with them coalesced.
  check(!published[1] && published[2] && !published[3] && !published[4] && !published[5] &&
            published[6],
        "every snapshot naming a pending texture is held; the newest ready one is published");
  check(hold.stats().held_callbacks == 4 && hold.stats().coalesced == 4 &&
            hold.stats().published_late == 1 && hold.stats().max_lag_frames == 1 &&
            hold.held() == 0,
        "held callbacks are counted and coalesced into the publish");
}

void test_holdback_newest_ready_wins() {
  Session async;
  async.async = true;
  async.mirror.set_root(kRootViewport, kRootCanvas, kRootXform);
  HoldBack hold;
  HeldSnapshot ready;
  bool publish = false;
  std::string error;
  // frame 1: create (job 0); frame 2: update replaces it (job 1) and finishes first.
  async.create(500, 1, 1);
  drawing_item(&async.mirror, 100, 500, 1);
  HeldSnapshot a;
  a.snapshot = async.mirror.snapshot(1, 1);
  a.frame = 1;
  hold.offer(std::move(a), 1, false, &ready, &publish, &error);
  check(!publish, "frame 1 held");
  async.update(500, 2, 2);
  async.finish(1);
  HeldSnapshot b;
  b.snapshot = async.mirror.snapshot(2, 2);
  b.frame = 2;
  hold.offer(std::move(b), 2, false, &ready, &publish, &error);
  check(publish && ready.frame == 2 && hold.held() == 0,
        "the newest ready snapshot is published although an older one is still pending");
  async.finish(0);  // the superseded job finishing late changes nothing
  HeldSnapshot c;
  c.snapshot = async.mirror.snapshot(3, 3);
  c.frame = 3;
  hold.offer(std::move(c), 3, false, &ready, &publish, &error);
  check(publish && ready.snapshot.pending.empty() && ready.snapshot.state.textures.size() == 1 &&
            ready.snapshot.state.textures[0].hash == async.results[1].hash,
        "a superseded job never reaches the entry");
}

void test_holdback_finish_and_fault() {
  Session async;
  async.async = true;
  async.mirror.set_root(kRootViewport, kRootCanvas, kRootXform);
  async.create(500, 1, 1);
  drawing_item(&async.mirror, 100, 500, 1);
  {
    HoldBack hold;
    HeldSnapshot s;
    s.snapshot = async.mirror.snapshot(1, 1);
    s.frame = 1;
    HeldSnapshot ready;
    bool publish = false;
    std::string error;
    hold.offer(std::move(s), 1, false, &ready, &publish, &error);
    check(!publish && hold.held() == 1, "held at the end of the stream");
    std::thread worker([&] {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      async.finish(0);
    });
    HeldSnapshot last;
    check(hold.take_newest(&last, &error) && last.frame == 1 && last.snapshot.pending.empty() &&
              last.snapshot.state.textures[0].hash == async.results[0].hash,
          "take_newest waits for the jobs and resolves the last held snapshot");
    worker.join();
    check(!hold.take_newest(&last, &error) && error.empty(), "nothing held afterwards");
  }
  // publish-before-ready: published at once, all-zero hash, no payload
  Session faulty;
  faulty.async = true;
  faulty.mirror.set_root(kRootViewport, kRootCanvas, kRootXform);
  faulty.create(500, 1, 1);
  HoldBack hold;
  HeldSnapshot s;
  s.snapshot = faulty.mirror.snapshot(1, 1);
  s.frame = 1;
  HeldSnapshot ready;
  bool publish = false;
  std::string error;
  check(hold.offer(std::move(s), 1, true, &ready, &publish, &error) && publish &&
            ready.snapshot.state.textures[0].hash == std::string(64, '0') &&
            ready.snapshot.payloads.empty(),
        "the fault publishes a pending texture with a zero hash and no payload");
  faulty.finish(0);
}

void test_mispredict() {
  Session async;
  async.async = true;
  async.mirror.set_root(kRootViewport, kRootCanvas, kRootXform);
  async.create(500, 1, 1);
  PayloadCopy refused = async.results[0];
  refused.status = "unsupported";
  refused.reason = "unsupported-format";
  async.jobs[0]->finish(refused, nullptr);
  HoldBack hold;
  HeldSnapshot s;
  s.snapshot = async.mirror.snapshot(1, 1);
  s.frame = 1;
  HeldSnapshot ready;
  bool publish = false;
  std::string error;
  check(!hold.offer(std::move(s), 1, false, &ready, &publish, &error) && !publish &&
            error.rfind("texture-worker-mispredict", 0) == 0,
        "a mispredict is the typed stream error, never a publish");
}

void test_mirror_stats_and_free() {
  Session async;
  async.async = true;
  async.mirror.set_root(kRootViewport, kRootCanvas, kRootXform);
  async.create(500, 1, 1);
  check(async.mirror.stats().texture_payload_bytes == 0, "a pending payload is not counted");
  async.finish(0);
  check(async.mirror.stats().texture_payload_bytes == async.result_bytes[0]->size(),
        "a finished job's payload is counted before it settles");
  // a texture freed while pending: no hold, a tombstone without a hash
  async.create(501, 2, 2);
  async.mirror.free_rid(501, 2);
  const Captured c = async.mirror.snapshot(2, 2);
  check(c.pending.empty(), "a freed pending texture holds nothing back");
  async.finish(1);
}

// --- hook log ---------------------------------------------------------------------------------

void test_log_order() {
  using grc::rs::ResourceLog;
  using grc::rs::TapContext;
  TapContext ctx;
  ctx.frame = 1;
  ctx.t_ns = 1000;
  PayloadPtr b0, b1;
  const PayloadCopy c0 = sync_copy(8, 8, 1, &b0);
  const PayloadCopy c1 = sync_copy(8, 8, 2, &b1);

  ResourceLog sync;
  sync.start(0, kRootViewport);
  sync.texture_2d_create(ctx, 500, c0);
  sync.texture_2d_placeholder_create(ctx, 501);
  sync.texture_2d_create(ctx, 502, c1);
  sync.texture_replace(ctx, 501, 502);
  sync.free_rid(ctx, 500);
  const std::string expected = sync.take_lines();

  ResourceLog async;
  async.start(0, kRootViewport);
  auto j0 = std::make_shared<TextureJob>(predicted(c0));
  auto j1 = std::make_shared<TextureJob>(predicted(c1));
  PayloadCopy p0 = predicted(c0);
  p0.worker = false;  // compare the columns the synchronous log has (the worker keys are extra)
  PayloadCopy p1 = predicted(c1);
  p1.worker = false;
  async.texture_2d_create(ctx, 500, p0, false, j0);
  async.texture_2d_placeholder_create(ctx, 501);
  async.texture_2d_create(ctx, 502, p1, false, j1);
  async.texture_replace(ctx, 501, 502);
  async.free_rid(ctx, 500);
  check(async.take_lines().empty() && async.deferred_lines() > 0,
        "nothing leaves while the first line waits for its hash");
  j1->finish(c1, b1);
  check(async.take_lines().empty(), "a later finished job does not jump the queue");
  j0->finish(c0, b0);
  check(async.take_lines() == expected && async.deferred_lines() == 0,
        "once every job is done the lines are the synchronous log, in order, byte for byte");

  // the worker keys appear only on a worker line
  ResourceLog keyed;
  keyed.start(0, kRootViewport);
  auto j2 = std::make_shared<TextureJob>(predicted(c0));
  j2->finish(c0, b0);
  keyed.texture_2d_create(ctx, 500, predicted(c0), false, j2);
  const std::string line = keyed.take_lines();
  check(line.find("\"worker\":true,\"hook_ns\":5,\"dup_ns\":1") != std::string::npos &&
            line.find(c0.hash) != std::string::npos,
        "a worker line carries its hash and the trailing worker keys");
  check(expected.find("\"worker\"") == std::string::npos, "a synchronous line has no worker keys");
}

}  // namespace

int main() {
  test_parse();
  test_pool();
  test_stop_race();
  test_job();
  test_holdback_equals_sync();
  test_holdback_newest_ready_wins();
  test_holdback_finish_and_fault();
  test_mispredict();
  test_mirror_stats_and_free();
  test_log_order();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_texture_worker: all tests passed\n");
  return 0;
}
