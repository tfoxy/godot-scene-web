// A coded body still being made, readable while it grows (rs_payload_rest.h "Sibling coding"):
// the producer appends its bytes as ordered chunks and then ends it, done or failed; any number of
// readers take the chunks that exist so far and are woken when more arrive. Engine-free and
// header-only, so the server (rs_ws) and the store share it without either knowing the other.
//
// Nothing here ever waits on the producer: read() copies chunk pointers under a short lock, and
// a wake is the reader's own non-blocking signal, called on the producer's thread with no lock
// held. A reader subscribes before it reads, so a chunk appended between the two is in the read,
// and one appended after it wakes the reader.
#ifndef GRC_RS_BODY_STREAM_H
#define GRC_RS_BODY_STREAM_H

#include "rs_page_allocator.h"
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>

namespace grc {
namespace rs {

// A reader's wake. Held weakly by every stream it subscribed to, so a reader that is gone is
// never called; wake() must be cheap and must not block (the producer calls it).
class StreamWaker {
 public:
  virtual ~StreamWaker() = default;
  virtual void wake() = 0;
};

class BodyStream {
 public:
  using Chunk = std::shared_ptr<const PageBytes>;
  enum class State : std::uint8_t { Open, Done, Failed };

  // Producer: one more chunk (empty chunks are dropped). Ignored once the stream has ended.
  void append(Chunk chunk) {
    if (chunk == nullptr || chunk->empty()) return;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (state_ != State::Open) return;
      bytes_ += chunk->size();
      chunks_.push_back(std::move(chunk));
    }
    notify(false);
  }
  // Producer: the end. Done means the chunks are the whole body; Failed means they are not and no
  // more will come. The first end wins; the wakers are released with it.
  void finish(bool ok) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (state_ != State::Open) return;
      state_ = ok ? State::Done : State::Failed;
    }
    notify(true);
  }

  // Reader: appends the chunks from index `from` on to `out` and returns the state as of that
  // read (Done: `out` now reaches the last chunk).
  State read(std::size_t from, std::vector<Chunk> *out) const {
    std::lock_guard<std::mutex> lock(mutex_);
    for (std::size_t i = from; i < chunks_.size(); ++i) out->push_back(chunks_[i]);
    return state_;
  }
  // Reader: `waker` is woken after each new chunk and at the end. A stream that has ended keeps
  // no waker (the reader's next read sees the end).
  void subscribe(const std::weak_ptr<StreamWaker> &waker) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (state_ != State::Open) return;
    for (const std::weak_ptr<StreamWaker> &w : wakers_) {
      if (!w.owner_before(waker) && !waker.owner_before(w)) return;  // already subscribed
    }
    wakers_.push_back(waker);
  }

  State state() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return state_;
  }
  std::uint64_t bytes() const {  // appended so far
    std::lock_guard<std::mutex> lock(mutex_);
    return bytes_;
  }

 private:
  // Wakes every live subscriber outside the lock (and forgets them all at the end).
  void notify(bool last) {
    std::vector<std::weak_ptr<StreamWaker>> wakers;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (last) {
        wakers.swap(wakers_);
      } else {
        wakers = wakers_;
      }
    }
    for (const std::weak_ptr<StreamWaker> &w : wakers) {
      if (const std::shared_ptr<StreamWaker> live = w.lock()) live->wake();
    }
  }

  mutable std::mutex mutex_;
  std::vector<Chunk> chunks_;
  std::vector<std::weak_ptr<StreamWaker>> wakers_;
  std::uint64_t bytes_ = 0;
  State state_ = State::Open;
};

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_BODY_STREAM_H
