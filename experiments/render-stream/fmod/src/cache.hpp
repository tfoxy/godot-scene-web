#ifndef GRC_CACHE_HPP
#define GRC_CACHE_HPP
#include "take.hpp"
#include <condition_variable>
#include <deque>
#include <list>
#include <map>
#include <mutex>
#include <thread>
namespace grc::fmod {
using SharedTake = std::shared_ptr<const Take>;
class TakeCache {
 public:
  TakeCache(std::string bankset, std::size_t limit, std::string directory);
  SharedTake find(const std::string &key);
  SharedTake hash(const std::string &hash);
  void put(const std::string &key, SharedTake);
  std::shared_ptr<const Bytes> index();
  std::size_t bytes() const;
 private:
  struct Entry { SharedTake take; std::list<std::string>::iterator order; };
  std::string bankset_, directory_;
  std::size_t limit_, bytes_ = 0;
  mutable std::mutex mutex_;
  std::map<std::string, Entry> entries_;
  std::list<std::string> order_;
  std::map<std::string, std::string> disk_;
  SharedTake read_disk(const std::string &);
  void remember(const std::string &, SharedTake);
};
// Tokens never repeat; an old duplicate release cannot free a later buffer.
class Buffers {
 public:
  int lend(std::shared_ptr<const Bytes>, grc_fmod_buf *);
  void release(void *);
  std::uint64_t unknown() const;
 private:
  mutable std::mutex mutex_;
  std::map<std::uintptr_t, std::shared_ptr<const Bytes>> live_;
  std::uintptr_t next_ = 1;
  std::uint64_t unknown_ = 0;
};
class TakePool {
 public:
  using Done = std::function<void(SharedTake)>;
  using Render = std::function<Take(const std::string &)>;
  TakePool(RenderConfig, unsigned workers, std::shared_ptr<TakeCache>,
           std::function<void(const std::string &)> failure, Render test_render = {});
  ~TakePool();
  void request(std::string key, Done);
  void stop();
 private:
  void run();
  RenderConfig config_;
  std::shared_ptr<TakeCache> cache_;
  std::function<void(const std::string &)> failure_;
  Render test_render_;
  std::mutex mutex_;
  std::condition_variable changed_;
  bool stopping_ = false;
  std::deque<std::string> queue_;
  std::map<std::string, std::vector<Done>> pending_;
  std::vector<std::thread> workers_;
};
}
#endif
