#ifndef GRC_BANKS_HPP
#define GRC_BANKS_HPP
#include "native_api.hpp"
#include "../grc_fmod.h"
#include <array>
#include <atomic>
#include <memory>
#include <string>
#include <vector>
namespace grc::fmod {
struct Entry {
  std::string path;
  std::array<std::uint8_t, 16> md5{};
  std::uint64_t offset = 0, bytes = 0;
  std::uint32_t source_index = 0;
};
// Setup may allocate; positional reads and the cursor slab do not.
class Pck {
 public:
  Pck(const std::string &path, const std::string &selected);
  ~Pck();
  Pck(const Pck &) = delete;
  Pck &operator=(const Pck &) = delete;
  const std::vector<Entry> &entries() const { return entries_; }
  bool read(const Entry &, std::uint64_t pos, void *, unsigned, unsigned &got) const noexcept;
 private:
  struct File;
  std::unique_ptr<File> file_;
  std::vector<Entry> entries_;
};
std::string bankset_hash(std::vector<Entry> entries);
class Banks {
 public:
  Banks(const grc_fmod_bank_source_v1 *source, const std::string &pck, const std::string &selected, void (*wake)(void *) = nullptr, void *wake_self = nullptr);
  ~Banks();
  void load(Api &, Studio *);
  void load_samples(Api &, Studio *);
  const std::string &hash() const { return hash_; }
  bool failed() const { return failed_.load(std::memory_order_acquire); }
  std::vector<std::string> paths() const;
 private:
  struct Context;
  std::unique_ptr<Pck> pck_;
  grc_fmod_bank_source_v1 source_{};
  std::vector<std::unique_ptr<Context>> contexts_;
  std::string hash_;
  std::atomic<bool> failed_{false};
  void (*wake_)(void *) = nullptr;
  void *wake_self_ = nullptr;
  void fail() noexcept;
  static Result GRC_NATIVE_CALL open(const char *, unsigned *, void **, void *) noexcept;
  static Result GRC_NATIVE_CALL close(void *, void *) noexcept;
  static Result GRC_NATIVE_CALL read(void *, void *, unsigned, unsigned *, void *) noexcept;
  static Result GRC_NATIVE_CALL seek(void *, unsigned, void *) noexcept;
};
}
#endif
