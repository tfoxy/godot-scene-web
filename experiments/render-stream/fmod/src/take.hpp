#ifndef GRC_TAKE_HPP
#define GRC_TAKE_HPP
#include "banks.hpp"
#include <functional>
#include <memory>
#include <string>
#include <vector>
namespace grc::fmod {
using Bytes = std::vector<std::uint8_t>;
struct RenderConfig {
  std::string core_lib, studio_lib, pck_path, banks;
  const grc_fmod_bank_source_v1 *source = nullptr;
  void (*wake)(void *) = nullptr;
  void *wake_self = nullptr;
  std::string bankset; // When supplied, reject a changed source before loading banks.
};
struct Take {
  Bytes pcm, wav;
  std::string hash, reason;
  std::uint32_t frames = 0;
  std::uint64_t first_mix_us = 0;
  bool capped = false;
};
// Validation completes before a Take can contain any PCM or WAV bytes.
Take validate_take(const std::vector<float> &, const std::array<double, 4> &, bool capped);
bool allow_oneshot(bool oneshot);
class TakeSystem {
 public:
  explicit TakeSystem(const RenderConfig &);
  ~TakeSystem();
  TakeSystem(const TakeSystem &) = delete;
  TakeSystem &operator=(const TakeSystem &) = delete;
  Take render(const std::string &canonical);
  const std::string &bankset() const { return banks_->hash(); }
  bool failed() const { return banks_->failed(); }
 private:
  struct Capture;
  Api api_;
  std::unique_ptr<Banks> banks_;
  Studio *studio_ = nullptr;
  Core *core_ = nullptr;
  std::array<std::unique_ptr<Capture>, 4> captures_;
  std::vector<float> samples_;
  void attach(unsigned index, const char *bus);
  void cleanup() noexcept;
};
}
#endif
