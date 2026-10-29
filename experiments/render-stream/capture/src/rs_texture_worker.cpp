#include "rs_texture_worker.h"

#include "rs_texture_delivery.h"

#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <chrono>
#include <cstdlib>
#include <cstring>

namespace grc {
namespace rs {

namespace {

bool digits(const char *value) {
  if (value == nullptr || *value == '\0') {
    return false;
  }
  for (const char *p = value; *p != '\0'; ++p) {
    if (*p < '0' || *p > '9') {
      return false;
    }
  }
  return std::strlen(value) <= 12;
}

std::uint64_t now_ns() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now().time_since_epoch())
                                        .count());
}

}  // namespace

bool parse_texture_workers(const char *workers, const char *min_bytes, const char *delay_ms,
                           const char *fault, TextureWorkerConfig *out, std::string *error,
                           const char *pending) {
  TextureWorkerConfig config;
  if (workers != nullptr && *workers != '\0' && std::strcmp(workers, "sync") != 0) {
    if (!digits(workers) || std::strtoull(workers, nullptr, 10) < 1 ||
        std::strtoull(workers, nullptr, 10) > static_cast<unsigned long long>(kMaxTextureWorkers)) {
      *error = std::string("invalid GRC_TEXTURE_WORKERS=") + workers + " (expected sync or 1.." +
               std::to_string(kMaxTextureWorkers) + ")";
      return false;
    }
    config.workers = static_cast<int>(std::strtoull(workers, nullptr, 10));
  }
  if (min_bytes != nullptr && *min_bytes != '\0') {
    if (!digits(min_bytes)) {
      *error = std::string("invalid GRC_TEXTURE_WORKER_MIN_BYTES=") + min_bytes +
               " (expected a decimal byte count)";
      return false;
    }
    config.min_bytes = std::strtoull(min_bytes, nullptr, 10);
  }
  if (delay_ms != nullptr && *delay_ms != '\0') {
    if (!digits(delay_ms) || std::strtoull(delay_ms, nullptr, 10) > 60000) {
      *error = std::string("invalid GRC_TEXTURE_WORKER_DELAY_MS=") + delay_ms +
               " (expected 0..60000)";
      return false;
    }
    config.delay_ms = std::strtoull(delay_ms, nullptr, 10);
  }
  if (fault != nullptr && *fault != '\0') {
    if (std::strcmp(fault, "publish-before-ready") != 0) {
      *error = std::string("invalid GRC_TEXTURE_WORKER_FAULT=") + fault +
               " (expected publish-before-ready)";
      return false;
    }
    if (!config.async()) {
      *error = "GRC_TEXTURE_WORKER_FAULT=publish-before-ready acts on the worker hold-back; set "
               "GRC_TEXTURE_WORKERS=<N>";
      return false;
    }
    config.fault_publish_before_ready = true;
  }
  if (pending != nullptr && *pending != '\0') {
    if (std::strcmp(pending, "hold") != 0 && std::strcmp(pending, "publish") != 0) {
      *error = std::string("invalid GRC_TEXTURE_PENDING=") + pending + " (expected hold or publish)";
      return false;
    }
    config.publish_pending = std::strcmp(pending, "publish") == 0;
    if (config.publish_pending && !config.async()) {
      *error = "GRC_TEXTURE_PENDING=publish acts on texture workers; set GRC_TEXTURE_WORKERS=<N>";
      return false;
    }
  }
  if (!config.async() && (config.delay_ms != 0)) {
    *error = "GRC_TEXTURE_WORKER_DELAY_MS delays texture workers; set GRC_TEXTURE_WORKERS=<N>";
    return false;
  }
  *out = config;
  return true;
}

std::string texture_workers_name(const TextureWorkerConfig &config) {
  return config.async() ? std::to_string(config.workers) : std::string("sync");
}

// --- the pool ----------------------------------------------------------------------------------

TextureWorkerPool::~TextureWorkerPool() { stop(); }

bool TextureWorkerPool::start(int workers, std::uint64_t delay_ms) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (running_ || workers < 1 || workers > kMaxTextureWorkers) {
    return false;
  }
  running_ = true;
  stopping_ = false;
  delay_ms_ = delay_ms;
  stats_ = Stats();
  for (int i = 0; i < workers; ++i) {
    threads_.emplace_back([this] { run(); });
  }
  return true;
}

bool TextureWorkerPool::running() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return running_ && !stopping_;
}

bool TextureWorkerPool::submit(std::function<void()> work) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!running_ || stopping_) {
      return false;
    }
    queue_.push_back(std::move(work));
    ++stats_.submitted;
    if (queue_.size() > stats_.max_queued) {
      stats_.max_queued = queue_.size();
    }
  }
  work_cv_.notify_one();
  return true;
}

void TextureWorkerPool::drain() {
  std::unique_lock<std::mutex> lock(mutex_);
  idle_cv_.wait(lock, [this] { return queue_.empty() && in_flight_ == 0; });
}

void TextureWorkerPool::stop() {
  std::vector<std::thread> threads;
  {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!running_) {
      return;
    }
    // Refuse new work first (a racing hook then copies inline), then let the queue empty.
    stopping_ = true;
    idle_cv_.wait(lock, [this] { return queue_.empty() && in_flight_ == 0; });
    threads.swap(threads_);
  }
  work_cv_.notify_all();
  for (std::thread &t : threads) {
    t.join();
  }
  std::lock_guard<std::mutex> lock(mutex_);
  running_ = false;
  stopping_ = false;
}

std::size_t TextureWorkerPool::discard_queued() {
  std::deque<std::function<void()>> dropped;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    dropped.swap(queue_);
  }
  idle_cv_.notify_all();
  return dropped.size();  // the closures are destroyed here, outside the lock
}

void TextureWorkerPool::wait_outstanding_at_most(std::size_t n) {
  std::unique_lock<std::mutex> lock(mutex_);
  idle_cv_.wait(lock, [this, n] { return !running_ || queue_.size() + in_flight_ <= n; });
}

TextureWorkerPool::Stats TextureWorkerPool::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return stats_;
}

void TextureWorkerPool::run() {
  // D11: below normal priority, so a busy main thread keeps the core it needs. setpriority() on
  // a thread id sets that thread's own nice value on Linux; failure (a sandbox) is harmless.
  (void)setpriority(PRIO_PROCESS, static_cast<id_t>(syscall(SYS_gettid)), 10);
  for (;;) {
    std::function<void()> work;
    std::uint64_t delay_ms = 0;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      work_cv_.wait(lock, [this] { return !queue_.empty() || stopping_; });
      if (queue_.empty()) {
        return;  // stopping and drained
      }
      work = std::move(queue_.front());
      queue_.pop_front();
      ++in_flight_;
      delay_ms = delay_ms_;
    }
    const std::uint64_t t0 = now_ns();
    if (delay_ms != 0) {
      // The test knob delays the job before it runs, so its result (and the hold-back it causes)
      // appears no sooner than `delay_ms` after the hook.
      std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
    }
    const std::uint64_t t1 = now_ns();
    work();
    work = nullptr;  // release the job's captures (the Image duplicate) on this thread
    const std::uint64_t t2 = now_ns();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      --in_flight_;
      ++stats_.completed;
      stats_.busy_ns += t2 - t1;
      if (t2 - t1 > stats_.max_job_ns) {
        stats_.max_job_ns = t2 - t1;
      }
      (void)t0;
    }
    idle_cv_.notify_all();
  }
}

TextureWorkerPool &texture_worker_pool() {
  static TextureWorkerPool pool;
  return pool;
}

// --- snapshots ----------------------------------------------------------------------------------

bool captured_ready(const Captured &captured) {
  for (const PendingTexture &p : captured.pending) {
    if (p.job == nullptr || !p.job->done()) {
      return false;
    }
  }
  return true;
}

bool resolve_captured(Captured *captured, bool fault, std::string *error) {
  if (!captured->pending.empty()) {
    captured->names_valid = false;  // HC4b: the entries move away from the mirror's name index
  }
  for (const PendingTexture &p : captured->pending) {
    if (p.index >= captured->state.textures.size() || p.job == nullptr) {
      continue;
    }
    rs2::TextureEntry &entry = captured->state.textures.mut(p.index);  // HC4b: copy-on-write
    if (!p.job->done()) {
      if (!fault) {
        *error = "texture-worker-unready: texture " + std::to_string(entry.id) +
                 " was published before its worker finished";
        return false;
      }
      // publish-before-ready: what a hold-back that forgot to wait would put on the wire.
      entry.hash = std::string(64, '0');
      continue;
    }
    if (p.job->mispredict()) {
      const PayloadCopy &a = p.job->actual();
      const PayloadCopy &e = p.job->predicted();
      *error = "texture-worker-mispredict: texture " + std::to_string(entry.id) +
               " was predicted " + e.status + " format " + std::to_string(e.format) +
               " but the worker's copy is " + a.status +
               (a.reason.empty() ? std::string() : " (" + a.reason + ")") + " format " +
               std::to_string(a.format) + "; set GRC_TEXTURE_WORKERS=sync";
      return false;
    }
    entry.hash = p.job->actual().hash;
    captured->payloads.emplace(entry.hash, p.job->bytes());
    // G8kp: the block variant the worker built beside the decode (rs_texture_delivery.h).
    const PayloadCopy &actual = p.job->actual();
    if (!actual.block_hash.empty() && actual.block_bytes != nullptr) {
      VariantRequest request;
      request.id = entry.id;
      request.hash = entry.hash;
      request.format = entry.format;
      request.width = entry.width;
      request.height = entry.height;
      request.mipmaps = entry.mipmaps;
      request.version = entry.version;
      request.block.hash = actual.block_hash;
      request.block.format = actual.block_format;
      request.block.payload_bytes = static_cast<std::uint64_t>(actual.block_payload_bytes);
      entry.variants = texture_variants(request);
      for (const rs2::TextureVariant &variant : entry.variants) {
        if (variant.hash == actual.block_hash) {
          captured->payloads.emplace(variant.hash, actual.block_bytes);
        }
      }
    }
  }
  captured->pending.clear();
  return true;
}

bool HoldBack::offer(HeldSnapshot snapshot, std::uint64_t callback_frame, bool fault,
                     HeldSnapshot *ready, bool *publish, std::string *error) {
  *publish = false;
  ++stats_.offered;
  held_.push_back(std::move(snapshot));
  if (held_.size() > max_held_) {
    held_.pop_front();  // the newer snapshots hold everything it held
    ++stats_.evicted;
  }
  if (held_.size() > stats_.max_held) {
    stats_.max_held = held_.size();
  }
  // The newest ready snapshot wins; every older one is coalesced into it. Under the fault the
  // newest is published whatever its jobs say.
  std::size_t pick = held_.size();
  for (std::size_t i = held_.size(); i-- > 0;) {
    if (fault || captured_ready(held_[i].snapshot)) {
      pick = i;
      break;
    }
  }
  if (pick == held_.size()) {
    ++stats_.held_callbacks;
    return true;
  }
  stats_.coalesced += pick;
  HeldSnapshot chosen = std::move(held_[pick]);
  held_.erase(held_.begin(), held_.begin() + static_cast<std::ptrdiff_t>(pick) + 1);
  if (!resolve_captured(&chosen.snapshot, fault, error)) {
    return false;
  }
  if (callback_frame > chosen.frame) {
    ++stats_.published_late;
    if (callback_frame - chosen.frame > stats_.max_lag_frames) {
      stats_.max_lag_frames = callback_frame - chosen.frame;
    }
  }
  *ready = std::move(chosen);
  *publish = true;
  return true;
}

bool HoldBack::take_newest(HeldSnapshot *out, std::string *error) {
  if (held_.empty()) {
    return false;
  }
  for (const PendingTexture &p : held_.back().snapshot.pending) {
    if (p.job != nullptr) {
      p.job->wait();
    }
  }
  stats_.coalesced += held_.size() - 1;
  HeldSnapshot chosen = std::move(held_.back());
  held_.clear();
  if (!resolve_captured(&chosen.snapshot, false, error)) {
    return false;
  }
  *out = std::move(chosen);
  return true;
}

}  // namespace rs
}  // namespace grc
