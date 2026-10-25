// P3-CAP (results/p3/p3-cap.md): one background thread for the file sinks' blocking I/O.
//
// At a game's scale the patch sink's out-of-band store writes one file per new mesh payload --
// about 70 a frame for a skeletal-animation scene -- and each costs an open, a write, a close, a
// rename and an index append. On the frame callback that was the largest single cost after the
// snapshot. The publisher still decides everything on the calling thread (which hashes are new,
// the index line, the wrong-hash corruption, the transaction bytes); only the I/O is queued here,
// and it runs strictly in submission order. So a store payload is on disk before any transaction
// naming it reaches its sink (gate2-design.md Q4 "File sinks"), and the files, the index and the
// recordings hold exactly the bytes a synchronous writer would have written, in the same order.
//
// A failed task is sticky: every later submit() returns false with its error (the publisher then
// ends the stream with it, one publication later than a synchronous write would have). submit()
// blocks while more than `max_queued_bytes` are queued, so a slow disk throttles the producer
// instead of growing the queue without bound.
//
// Engine-free, header-only.
#ifndef GRC_RS_FILE_WRITER_H
#define GRC_RS_FILE_WRITER_H

#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

namespace grc {
namespace rs {

class FileWriter {
 public:
  // A unit of I/O. Returns false and sets *error on failure.
  using Task = std::function<bool(std::string *error)>;

  explicit FileWriter(std::size_t max_queued_bytes = std::size_t{256} << 20)
      : max_queued_bytes_(max_queued_bytes) {
    thread_ = std::thread([this] { run(); });
  }
  ~FileWriter() { stop(); }
  FileWriter(const FileWriter &) = delete;
  FileWriter &operator=(const FileWriter &) = delete;

  // Queues `task` (`bytes`: what it holds, for the bound). False, with the first failure's
  // error, once any task has failed or the writer stopped; the task is then dropped.
  bool submit(Task task, std::size_t bytes, std::string *error) {
    std::unique_lock<std::mutex> lock(mutex_);
    space_.wait(lock, [&] {
      return failed_ || stopping_ || queue_.empty() || queued_bytes_ + bytes <= max_queued_bytes_;
    });
    if (failed_ || stopping_) {
      if (error != nullptr) {
        *error = failed_ ? error_ : std::string("file writer stopped");
      }
      return false;
    }
    queue_.emplace_back(std::move(task), bytes);
    queued_bytes_ += bytes;
    ++submitted_;
    work_.notify_one();
    return true;
  }

  // Waits until every task submitted so far has run. True when none failed.
  bool drain(std::string *error = nullptr) {
    std::unique_lock<std::mutex> lock(mutex_);
    idle_.wait(lock, [&] { return completed_ == submitted_; });
    if (failed_ && error != nullptr) {
      *error = error_;
    }
    return !failed_;
  }

  bool failed(std::string *error = nullptr) const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (failed_ && error != nullptr) {
      *error = error_;
    }
    return failed_;
  }

  // Runs what is queued, then joins the thread. Idempotent.
  void stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_ && !thread_.joinable()) {
        return;
      }
      stopping_ = true;
      work_.notify_all();
      space_.notify_all();
    }
    if (thread_.joinable()) {
      thread_.join();
    }
  }

 private:
  void run() {
    std::unique_lock<std::mutex> lock(mutex_);
    for (;;) {
      work_.wait(lock, [&] { return stopping_ || !queue_.empty(); });
      if (queue_.empty()) {
        return;  // stopping, and everything queued has run
      }
      std::pair<Task, std::size_t> next = std::move(queue_.front());
      queue_.pop_front();
      const bool skip = failed_;
      lock.unlock();
      std::string error;
      const bool ok = skip || next.first(&error);
      next.first = nullptr;  // release what the task held before taking the lock
      lock.lock();
      queued_bytes_ -= next.second;
      if (!ok && !failed_) {
        failed_ = true;
        error_ = error;
      }
      ++completed_;
      space_.notify_all();
      if (completed_ == submitted_) {
        idle_.notify_all();
      }
    }
  }

  const std::size_t max_queued_bytes_;
  mutable std::mutex mutex_;
  std::condition_variable work_;
  std::condition_variable space_;
  std::condition_variable idle_;
  std::deque<std::pair<Task, std::size_t>> queue_;
  std::size_t queued_bytes_ = 0;
  std::uint64_t submitted_ = 0;
  std::uint64_t completed_ = 0;
  bool failed_ = false;
  bool stopping_ = false;
  std::string error_;
  std::thread thread_;
};

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_FILE_WRITER_H
