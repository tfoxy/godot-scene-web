// The texture worker pool (texture-delivery-design.md D11, Q7; G8kw).
//
// Under GRC_TEXTURE_WORKERS=<N> the texture hooks (hooks.cpp texture_2d_create/_update) stop
// copying, decoding and hashing an Image on the RenderingServer caller. The hook still reads the
// Image's facts (format, size, mipmaps, data size) and classifies the copy exactly as the
// synchronous path does, so a texture's status, reason, shape and payload size are known at the
// hook: only the content -- the payload bytes and their SHA-256 -- is computed later. The hook
// takes a copy-on-write `Resource.duplicate(false)` of the Image (it shares the engine's bytes;
// the engine may free or mutate its own Image at once, which then copies on write) and hands it to
// a capture-owned worker thread. The worker runs the synchronous path's own copy, host decode
// (G8t) and hash on that private duplicate and fills a TextureJob. Workers never call the
// RenderingServer and never write a sink.
//
// Publication hold-back (Q7): the mirror records a pending entry with its job; a snapshot that
// names an `ok` image whose job has not finished is held (HoldBack) and published once the job is
// done, newer held snapshots coalescing older ones exactly like a stall, with no wire change. A
// file sink stamps the snapshot's own frame, so an async recording's transactions are a subset of
// the synchronous recording's, state for state. The hook log (rs_resource_log.h) holds a line that
// needs a pending hash, and every line after it, until the hash is ready, so its order is the
// synchronous order.
//
// GRC_TEXTURE_WORKERS=sync (the default) never reaches any of this: every hook copies, decodes and
// hashes on the calling thread, byte for byte as before G8kw.
//
// A worker's actual copy is checked against the hook's prediction (`mispredict`): the only way they
// can differ is an engine decoder that fails on a format the D8 table decodes, which the caller
// turns into the typed stream error `texture-worker-mispredict` rather than publish a guess.
#ifndef GRC_RS_TEXTURE_WORKER_H
#define GRC_RS_TEXTURE_WORKER_H

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rs_captured.h"
#include "rs_resource_log.h"

namespace grc {
namespace rs {

// GRC_TEXTURE_WORKERS and its test knobs, parsed once at arm.
struct TextureWorkerConfig {
  int workers = 0;  // 0 = sync (the default): the hook copies, decodes and hashes itself
  // GRC_TEXTURE_WORKER_MIN_BYTES: an image whose data is smaller stays synchronous (a 64 KiB
  // payload hashes in ~30 us, less than a job's hand-off). 0 sends every copy to the pool.
  std::uint64_t min_bytes = 65536;
  // GRC_TEXTURE_WORKER_DELAY_MS (a test knob, default 0): a worker sleeps this long before it
  // marks a job done, so a gate leg can hold publication back deterministically.
  std::uint64_t delay_ms = 0;
  // GRC_TEXTURE_WORKER_FAULT=publish-before-ready (a fault knob for the sabotage leg, never on the
  // wire): a snapshot naming a pending texture is published at once, its hash all zeros.
  bool fault_publish_before_ready = false;
  bool async() const { return workers > 0; }
};

constexpr int kMaxTextureWorkers = 16;

// Each argument is the raw environment value or nullptr when unset. False with `error` set on an
// invalid value (the stream then refuses to start): `workers` must be `sync` or 1..16, the two
// numbers decimal digits, `fault` empty or publish-before-ready (which needs N workers).
bool parse_texture_workers(const char *workers, const char *min_bytes, const char *delay_ms,
                           const char *fault, TextureWorkerConfig *out, std::string *error);

// "sync" or the worker count, for logs and result.json.
std::string texture_workers_name(const TextureWorkerConfig &config);

// One texture copy handed to a worker. The hook creates it with its prediction; the worker
// finishes it exactly once. Header-only, so the mirror and the hook log need no pool to hold one.
class TextureJob {
 public:
  explicit TextureJob(const PayloadCopy &predicted) : predicted_(predicted) {}

  // The worker's result: `actual` is the synchronous path's PayloadCopy for the same image, `bytes`
  // its GRT1 payload (null unless ok). Marks a mispredict when `actual` disagrees with the
  // prediction in anything but the content fields (hash and the cost columns).
  void finish(const PayloadCopy &actual, PayloadPtr bytes) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      actual_ = actual;
      bytes_ = std::move(bytes);
      mispredict_ = !same_facts(predicted_, actual_) || (actual_.status == "ok" && bytes_ == nullptr);
      done_.store(true, std::memory_order_release);
    }
    cv_.notify_all();
  }

  bool done() const { return done_.load(std::memory_order_acquire); }
  void wait() const {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [this] { return done_.load(std::memory_order_acquire); });
  }
  // Valid once done().
  const PayloadCopy &actual() const { return actual_; }
  const PayloadPtr &bytes() const { return bytes_; }
  bool mispredict() const { return mispredict_; }
  const PayloadCopy &predicted() const { return predicted_; }

  // `copy` (a prediction) takes the job's content fields: hash, copy/hash/decode times.
  void fill(PayloadCopy *copy) const {
    copy->hash = actual_.hash;
    copy->copy_ns = actual_.copy_ns;
    copy->hash_ns = actual_.hash_ns;
    copy->decode_ns = actual_.decode_ns;
  }

  static bool same_facts(const PayloadCopy &a, const PayloadCopy &b) {
    return a.status == b.status && a.reason == b.reason && a.format == b.format &&
           a.width == b.width && a.height == b.height && a.mipmaps_known == b.mipmaps_known &&
           a.mipmaps == b.mipmaps && a.data_bytes == b.data_bytes &&
           a.payload_bytes == b.payload_bytes && a.source_format == b.source_format;
  }

 private:
  PayloadCopy predicted_;
  mutable std::mutex mutex_;
  mutable std::condition_variable cv_;
  std::atomic<bool> done_{false};
  PayloadCopy actual_;
  PayloadPtr bytes_;
  bool mispredict_ = false;
};

using TextureJobPtr = std::shared_ptr<TextureJob>;

// The capture-owned pool. start() spawns `workers` threads at below-normal priority (nice +10);
// submit() queues a closure (false when the pool is not running: the caller then runs it inline,
// so a hook racing a stop never loses a copy); drain() waits until every queued job has run;
// stop() drains, then joins every thread. Thread-safe.
class TextureWorkerPool {
 public:
  TextureWorkerPool() = default;
  ~TextureWorkerPool();
  TextureWorkerPool(const TextureWorkerPool &) = delete;
  TextureWorkerPool &operator=(const TextureWorkerPool &) = delete;

  bool start(int workers, std::uint64_t delay_ms);
  bool running() const;
  bool submit(std::function<void()> work);
  void drain();
  void stop();

  struct Stats {
    std::uint64_t submitted = 0;
    std::uint64_t completed = 0;
    std::uint64_t max_queued = 0;    // the deepest the queue got (jobs not yet started)
    std::uint64_t busy_ns = 0;       // summed worker time inside jobs (delay excluded)
    std::uint64_t max_job_ns = 0;
  };
  Stats stats() const;

 private:
  void run();

  mutable std::mutex mutex_;
  std::condition_variable work_cv_;
  std::condition_variable idle_cv_;
  std::deque<std::function<void()>> queue_;
  std::vector<std::thread> threads_;
  bool running_ = false;
  bool stopping_ = false;
  std::size_t in_flight_ = 0;
  std::uint64_t delay_ms_ = 0;
  Stats stats_;
};

// The process-wide pool the hooks submit to and entry.cpp starts and stops.
TextureWorkerPool &texture_worker_pool();

// Whether `captured`'s pending entries all have their hashes.
bool captured_ready(const Captured &captured);

// Fills every pending entry of `captured` from its job (hash, payload) and clears `pending`. False
// with `error` set when a job mispredicted. Under `fault` (publish-before-ready) an unfinished
// job's entry gets 64 zeros and no payload instead of waiting; otherwise every job must be done.
bool resolve_captured(Captured *captured, bool fault, std::string *error);

// Publication hold-back (Q7). The frame callback offers each snapshot it took; offer() returns
// the one to publish now: the newest held snapshot whose textures are all ready (resolved, older
// ones dropped as coalesced), or none. Single-threaded (the frame callback and stream finish).
struct HeldSnapshot {
  Captured snapshot;
  std::uint64_t frame = 0;        // the frame the snapshot is of (a file sink stamps it)
  std::uint64_t epoch = 0;        // the mirror epoch read before it was copied
  std::uint64_t snapshot_ns = 0;  // its copy time
};

class HoldBack {
 public:
  explicit HoldBack(std::size_t max_held = 64) : max_held_(max_held) {}

  // `ready` receives the snapshot to publish when there is one (the return value says so).
  // `error` is set (and false returned) on a mispredict. `callback_frame` dates the offer.
  bool offer(HeldSnapshot snapshot, std::uint64_t callback_frame, bool fault, HeldSnapshot *ready,
             bool *publish, std::string *error);
  // At stream finish, after the pool drained: the newest held snapshot, resolved (false when none
  // or on a mispredict, `error` then set).
  bool take_newest(HeldSnapshot *out, std::string *error);
  std::size_t held() const { return held_.size(); }
  void clear() { held_.clear(); }

  struct Stats {
    std::uint64_t offered = 0;
    std::uint64_t held_callbacks = 0;  // callbacks that published nothing because of a hold
    std::uint64_t published_late = 0;  // publishes of a snapshot older than their callback
    std::uint64_t coalesced = 0;       // held snapshots superseded before they were published
    std::uint64_t evicted = 0;         // held snapshots dropped at max_held
    std::uint64_t max_lag_frames = 0;  // callback frame - published snapshot frame, max
    std::uint64_t max_held = 0;
  };
  const Stats &stats() const { return stats_; }

 private:
  std::size_t max_held_;
  std::deque<HeldSnapshot> held_;
  Stats stats_;
};

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TEXTURE_WORKER_H
