#pragma once

#include <chrono>
#include <cstdint>
#include <exception>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>

#include "calib_fingerprint.h"

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace grc {
// Startup-loaded modes must hook before resource creation. Only detached first use may wait.
inline bool async_identity_digest(std::string_view platform, std::string_view mode) {
  return platform == "windows-x86_64" && mode == "detached";
}

struct ImageDigestResult {
  bool ok = false;
  std::string hex, whole_file_hex, error;
  uint64_t bytes = 0, image_base = 0, ns = 0;
};

// Derived records retain the whole-file identity. Request it alongside the image digest
// so both digests share file reads; shipped records need only the image digest.
inline ImageDigestResult compute_windows_image_digest(
    const std::string &path, bool derived, decltype(&pe_image_sha256) hash = pe_image_sha256) {
  ImageDigestResult result;
  result.ok = hash(path, &result.hex, &result.bytes, &result.image_base, &result.error,
                   derived ? &result.whole_file_hex : nullptr);
  return result;
}

// Complete the metadata-only fingerprint before any calibrated address is used.
inline bool resolve_windows_image_digest(ProcessFingerprint *fp, const ImageDigestResult &result,
                                         std::string *error) {
  if (!result.ok) {
    *error = result.error.empty() ? "image digest unavailable" : result.error;
    return false;
  }
  // Metadata collection uses the mapped header. Windows may rewrite its ImageBase
  // to the loaded address; only the hashed file supplies the preferred base.
  const uint64_t mapped_base = fp->image_base;
  const uint64_t loaded_base = mapped_base + fp->load_bias;
  if (mapped_base != result.image_base && mapped_base != loaded_base) {
    *error = "mapped PE ImageBase is neither preferred nor loaded base";
    return false;
  }
  fp->image_base = result.image_base;
  fp->load_bias = loaded_base - result.image_base;
  fp->image_sha256 = result.hex;
  fp->exe_sha256 = result.whole_file_hex;
  return true;
}

// Started only by the first identity attempt. Completion is an event, never a frame poll.
// The provider owns only file data; post must enqueue a main-thread callback, not execute it.
class IdentityDigest {
 public:
  using Provider = std::function<ImageDigestResult()>;
  ~IdentityDigest() { shutdown(); }
  bool start(const std::string &platform, std::string_view mode, Provider provider, std::function<void()> post) {
    if (!async_identity_digest(platform, mode) || started_) return false;
    started_ = true;
    thread_ = std::thread([this, provider = std::move(provider), post = std::move(post)] {
#if defined(_WIN32)
      // Lower this worker's native priority before hashing so game threads take precedence.
      SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
#endif
      const auto start = std::chrono::steady_clock::now();
      ImageDigestResult result;
      try { result = provider(); }
      catch (const std::exception &e) { result.error = e.what(); }
      catch (...) { result.error = "image digest provider failed"; }
      result.ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now() - start).count();
      std::lock_guard<std::mutex> lock(mutex_);
      result_ = std::move(result);
      finished_ = true;
      // Serialize posting with the shutdown latch: join cannot leave a new event behind.
      if (!stopped_) post();
    });
    return true;
  }
  bool result(ImageDigestResult *out) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_ || !finished_) return false;
    *out = result_;
    return true;
  }
  bool stopped() {
    std::lock_guard<std::mutex> lock(mutex_);
    return stopped_;
  }
  void shutdown() {
    { std::lock_guard<std::mutex> lock(mutex_); stopped_ = true; }
    // Completion never joins on main. Only shutdown owns the joinable thread.
    if (thread_.joinable()) thread_.join();
  }
 private:
  std::thread thread_;
  std::mutex mutex_;
  ImageDigestResult result_;
  bool started_ = false, stopped_ = false, finished_ = false;
};
}  // namespace grc
