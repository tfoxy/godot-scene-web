#pragma once

#include <atomic>
#include <cstdint>

namespace grc {
// Close and reader admission share one atomic word: a thunk fetched before vptr restoration
// either owns a reader or passes directly to the immutable engine function. Closed admission
// remains valid while the library is resident, including for delayed virtual dispatches.
class HookAdmission {
 public:
  class Reader {
   public:
    explicit Reader(HookAdmission &owner) : owner_(owner), admitted_(owner.enter()) {}
    ~Reader() { if (admitted_) owner_.word_.fetch_sub(1, std::memory_order_release); }
    explicit operator bool() const { return admitted_; }
    Reader(const Reader &) = delete;
    Reader &operator=(const Reader &) = delete;
   private:
    HookAdmission &owner_;
    bool admitted_;
  };
  void close() { word_.fetch_or(kClosed, std::memory_order_acq_rel); }
  bool drained() const { return word_.load(std::memory_order_acquire) == kClosed; }
  void open() { word_.store(0, std::memory_order_release); }
 private:
  bool enter() {
    auto word = word_.load(std::memory_order_relaxed);
    while (!(word & kClosed)) {
      if (word_.compare_exchange_weak(word, word + 1, std::memory_order_acquire,
                                     std::memory_order_relaxed)) return true;
    }
    return false;
  }
  static constexpr std::uint64_t kClosed = std::uint64_t{1} << 63;
  std::atomic<std::uint64_t> word_{0};
};
}  // namespace grc
