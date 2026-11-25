#include "../grc_fmod.h"
#include "cache.hpp"
#include "link.hpp"
#include "lane.hpp"
#include "clock.hpp"
#include "rs_audio_wire.h"
#include <charconv>
#include <cmath>
#include <deque>
#include <limits>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
namespace grc::fmod {
namespace {
void copy_reason(char *out, std::size_t cap, const std::string &reason) {
  if (!out || !cap) return;
  const auto n = std::min(cap - 1, reason.size());
  std::memcpy(out, reason.data(), n);
  out[n] = '\0';
}
class Module {
 public:
  int start(const grc_fmod_host_v1 *host, const grc_fmod_bank_source_v1 *banks, char *error, std::size_t cap) {
    std::unique_lock lock(mutex_);
    if (attempted_) { copy_reason(error, cap, reason_); return on_; }
    attempted_ = true;
    if (!host || host->abi_version != GRC_FMOD_ABI_VERSION || host->size < sizeof(*host) || !host->config) {
      reason_ = "create";
      copy_reason(error, cap, reason_);
      return 0;
    }
    const auto callbacks = *host;
    grc_fmod_bank_source_v1 source{};
    if (banks) {
      if (banks->abi_version != GRC_FMOD_ABI_VERSION || banks->size < sizeof(*banks)) {
        reason_ = "bank-load";
        copy_reason(error, cap, reason_);
        return 0;
      }
      source = *banks;
    }
    try {
      std::thread([this, callbacks, source, supplied = banks != nullptr] {
        run(callbacks, supplied ? &source : nullptr);
      }).detach();
    } catch (...) {
      reason_ = "create";
      copy_reason(error, cap, reason_);
      return 0;
    }
    changed_.wait(lock, [this] { return ready_; });
    copy_reason(error, cap, reason_);
    return on_;
  }
  int state(char *reason, std::size_t cap) {
    std::lock_guard lock(mutex_);
    copy_reason(reason, cap, reason_);
    return on_;
  }
  void stop() {
    std::lock_guard lock(mutex_);
    stopping_ = true;
    on_ = false;
    if (reason_.empty() || !attempted_) reason_ = "stopped";
    attempted_ = true;
    changed_.notify_all();
  }
  void seat_open(std::uint32_t seat) { post([seat](Link &link, LaneState &, LaneSystem *) { link.open(seat); }); }
  void seat_close(std::uint32_t seat) { post([seat](Link &link, LaneState &, LaneSystem *) { link.close(seat); }); }
  void link_in(std::uint32_t seat, const std::uint8_t *msg, std::size_t len) {
    if ((!msg && len) || !len || len > 65536) return;
    post([seat, bytes = Bytes(msg, msg + len)](Link &link, LaneState &, LaneSystem *) { link.input(seat, bytes); });
  }
  void observe(std::uint32_t op, std::uint64_t instance, const char *s, std::size_t len, float value) {
    if (op < 1 || op > 9 || (!s && len) || len > 4096 || !std::isfinite(value)) return;
    Observation observation{op, instance, len ? std::string(s, len) : std::string{}, value};
    if (observation.text.find('\0') != std::string::npos) return;
    post([observation = std::move(observation)](Link &, LaneState &state, LaneSystem *lanes) {
      state.apply(observation); if (lanes) lanes->observe(observation);
    });
  }
  void release(void *owner) { buffers_.release(owner); }
  int take_get(const uint8_t *hash, grc_fmod_buf *out) {
    if (out) *out = {};
    if (!hash || !out) return -1;
    std::shared_ptr<TakeCache> cache;
    { std::lock_guard lock(mutex_); cache = cache_; }
    if (!cache) return 0;
    auto take = cache->hash(grc::audio::hex(Bytes(hash, hash + 32)));
    if (!take) return 0;
    return buffers_.lend(std::shared_ptr<const Bytes>(take, &take->wav), out);
  }
  int take_index(grc_fmod_buf *out) {
    if (out) *out = {};
    std::shared_ptr<TakeCache> cache;
    { std::lock_guard lock(mutex_); cache = cache_; }
    return cache ? buffers_.lend(cache->index(), out) : -1;
  }
 private:
  using Command = std::function<void(Link &, LaneState &, LaneSystem *)>;
  void post(Command command) {
    std::lock_guard lock(mutex_);
    if (!attempted_ || stopping_) return;
    commands_.push_back(std::move(command)); changed_.notify_all();
  }
  void run(const grc_fmod_host_v1 &host, const grc_fmod_bank_source_v1 *source) noexcept {
    std::string failure;
    try {
      auto config = [&](const char *key, const char *fallback = "") {
        const char *value = host.config(host.host, key);
        return std::string(value ? value : fallback);
      };
#if defined(_WIN32)
      const auto core = config("core_lib", "fmod.dll"), studio_name = config("studio_lib", "fmodstudio.dll");
#elif defined(__APPLE__)
      const auto core = config("core_lib", "libfmod.dylib"), studio_name = config("studio_lib", "libfmodstudio.dylib");
#else
      const auto core = config("core_lib", "libfmod.so.14"), studio_name = config("studio_lib", "libfmodstudio.so.14");
#endif
      Api api;
      api.bind(core.c_str(), studio_name.c_str());
      // Banks outlive the Studio system, including release-time file callbacks.
      std::unique_ptr<Banks> banks;
      struct System {
        Api &api;
        Studio *value;
        ~System() { if (value) api.studio_release(value); }
      } system{api, api.create()};
      banks = std::make_unique<Banks>(source, config("pck_path"), config("banks"), [](void *s) {
        auto *module = static_cast<Module *>(s);
        std::lock_guard lock(module->mutex_);
        module->changed_.notify_all();
      }, this);
      Core *native_core = nullptr;
      if (api.get_core(system.value, &native_core) != ok ||
          api.set_output(native_core, 4) != ok || // NOSOUND_NRT
          api.set_format(native_core, 48000, 3, 0) != ok || // stereo
          api.initialize(system.value, 256, 4 | 16, 1 | 2, nullptr) != ok)
        throw std::runtime_error("create");
      banks->load(api, system.value);
      auto number = [&](const char *key, std::size_t fallback) {
        auto text = config(key); if (text.empty()) return fallback;
        std::size_t value = 0;
        auto result = std::from_chars(text.data(), text.data() + text.size(), value);
        if (result.ec != std::errc{} || result.ptr != text.data() + text.size()) throw std::runtime_error("create");
        return value;
      };
      auto workers = number("take_workers", 1);
      if (workers < 1 || workers > 2) throw std::runtime_error("create");
      auto cache = std::make_shared<TakeCache>(banks->hash(), number("take_cache_bytes", 64 * 1024 * 1024), config("take_cache_dir"));
      RenderConfig render_config{core, studio_name, config("pck_path"), config("banks"), source,
        [](void *self) { auto *module = static_cast<Module *>(self); module->bank_failure_.store(true); module->changed_.notify_all(); }, this, banks->hash()};
      auto pool = std::make_shared<TakePool>(render_config, workers, cache,
        [this](const std::string &reason) {
          std::lock_guard lock(mutex_);
          if (async_failure_.empty()) async_failure_ = reason;
          changed_.notify_all();
        });
      auto lanes_config = parse_lanes(config("lanes"), [&](const std::string &reason) {
        if (host.log) host.log(host.host, 1, reason.data(), reason.size());
      });
      std::vector<grc::audio::LinkLane> announcement;
      for (const auto &lane : lanes_config) announcement.push_back(lane.wire);
      const auto domain = clock_domain();
      if (domain == std::string(32, '0')) throw std::runtime_error("clock-domain");
      Link link(domain, banks->hash(), std::move(announcement),
        [&](std::uint32_t seat, const Bytes &bytes) {
          if (host.link_out) host.link_out(host.host, seat, bytes.data(), bytes.size());
        },
        [this, pool](std::uint32_t seat, std::uint64_t generation, const grc::audio::LinkMessage &want) {
          pool->request(want.key, [this, seat, generation, want](SharedTake take) {
            post([seat, generation, want, take](Link &link, LaneState &, LaneSystem *) { link.take(seat, generation, want, take); });
          });
        }, [&](std::uint32_t seat, const std::string &reason) {
          const auto line = "grc_fmod seat " + std::to_string(seat) + " off: " + reason;
          if (host.log) host.log(host.host, 1, line.data(), line.size());
        });
      LaneState live(banks->paths());
      std::unique_ptr<LaneSystem> lanes;
      std::uint32_t epoch = 0, index = 0;
      std::uint64_t started = 0, next_due = 0;
      bool gap = false, disabled = false;
      auto disable = [&](const std::string &reason) {
        if (disabled) return;
        disabled = true;
        { std::lock_guard lock(mutex_); on_ = false; reason_ = reason; }
        link.disable(); lanes.reset(); pool->stop();
        if (host.log) {
          const auto line = "grc_fmod off: " + reason;
          host.log(host.host, 1, line.data(), line.size());
        }
      };
      {
        std::lock_guard lock(mutex_);
        cache_ = cache; pool_ = pool;
        on_ = !stopping_; reason_ = stopping_ ? "stopped" : ""; ready_ = true; changed_.notify_all();
      }
      for (;;) {
        std::deque<Command> commands;
        {
          std::unique_lock lock(mutex_);
          auto work = [&] { return stopping_ || (!disabled && (banks->failed() || bank_failure_.load() || !async_failure_.empty())) || !commands_.empty(); };
          if (lanes) changed_.wait_until(lock, std::chrono::steady_clock::time_point(std::chrono::microseconds(next_due)), work);
          else changed_.wait(lock, work);
          if (stopping_) break;
          commands.swap(commands_);
        }
        std::string async;
        { std::lock_guard lock(mutex_); async = async_failure_; }
        if (!async.empty()) disable(async);
        if (banks->failed() || bank_failure_.load()) disable("bank-load");
        for (auto &command : commands) {
          try { command(link, live, lanes.get()); }
          catch (const std::exception &error) { disable(error.what()); }
          catch (...) { disable("fmod-off"); }
        }
        try {
          const auto mask = link.mask();
          if (!mask) { lanes.reset(); started = next_due = 0; continue; }
          if (!lanes) {
            lanes = std::make_unique<LaneSystem>(render_config, lanes_config, live);
            if (++epoch == 0) throw std::runtime_error("fmod-off");
            started = next_due = now_us(); index = 0; gap = false;
          }
          if (now_us() < next_due) continue;
          // The lane media clock exists only while the union subscription is nonzero.
          // Anchor to frame zero; after a stall skip expired blocks, never build backlog.
          lanes->render(mask, epoch, index, next_due, [&](const grc::audio::BlockHeader &header, const Bytes &pcm) {
            auto marked = header; if (gap) marked.flags |= 8; link.lane(marked, pcm);
          });
          const auto next = std::max<std::uint64_t>(std::uint64_t(index) + 1, (now_us() - started) * 48000 / (512 * 1000000ULL));
          if (next > std::numeric_limits<std::uint32_t>::max()) throw std::runtime_error("fmod-off");
          gap = next != std::uint64_t(index) + 1; index = next;
          next_due = started + std::uint64_t(index) * 512 * 1000000 / 48000;
        } catch (const std::exception &error) { disable(error.what()); }
          catch (...) { disable("fmod-off"); }
      }
      link.disable(); pool->stop();
      if (host.log && (live.bank_loads || live.bank_unloads)) {
        const auto line = "grc_fmod banks: load=" + std::to_string(live.bank_loads) +
          " unload=" + std::to_string(live.bank_unloads) + " bank-unknown=" + std::to_string(live.bank_unknown);
        host.log(host.host, 0, line.data(), line.size());
      }

    } catch (const std::exception &error) {
      failure = error.what();
    } catch (...) {
      failure = "create";
    }
    if (!failure.empty() && host.log) {
      // One diagnostic for the first failure. No product callback holds our locks.
      const std::string line = "grc_fmod off: " + failure;
      host.log(host.host, 1, line.data(), line.size());
    }
    std::shared_ptr<TakePool> teardown;
    {
      std::lock_guard lock(mutex_);
      teardown = std::move(pool_); commands_.clear();
      on_ = false;
      if (!failure.empty()) reason_ = failure;
      ready_ = true;
      changed_.notify_all();
    }
    // Joining workers must never hold the lock used by their completion posts.
    if (teardown) teardown->stop();
  }
  std::mutex mutex_;
  std::condition_variable changed_;
  bool attempted_ = false, ready_ = false, on_ = false, stopping_ = false;
  std::string reason_ = "not-started";
  std::atomic<bool> bank_failure_{false};
  std::string async_failure_;
  std::deque<Command> commands_;
  Buffers buffers_;
  std::shared_ptr<TakeCache> cache_;
  std::shared_ptr<TakePool> pool_;
};
Module &module() {
  // The entry point and worker live for process life. Hosts must never dlclose us.
  static auto *value = new Module;
  return *value;
}
}
}
extern "C" GRC_FMOD_EXPORT int grc_fmod_get_v1(grc_fmod_v1 *out) {
  if (!out) return 0;
  try {
    *out = {
      GRC_FMOD_ABI_VERSION, sizeof(grc_fmod_v1), &grc::fmod::module(),
      [](void *s, const grc_fmod_host_v1 *h, const grc_fmod_bank_source_v1 *b, char *e, size_t n) {
        return static_cast<grc::fmod::Module *>(s)->start(h, b, e, n);
      },
      [](void *s, char *r, size_t n) { return static_cast<grc::fmod::Module *>(s)->state(r, n); },
      [](void *s, uint32_t seat) { try { static_cast<grc::fmod::Module *>(s)->seat_open(seat); } catch (...) {} },
      [](void *s, uint32_t seat) { try { static_cast<grc::fmod::Module *>(s)->seat_close(seat); } catch (...) {} },
      [](void *s, uint32_t seat, const uint8_t *msg, size_t len) { try { static_cast<grc::fmod::Module *>(s)->link_in(seat, msg, len); } catch (...) {} },
      [](void *s, uint32_t op, uint64_t id, const char *text, size_t len, float value) { try { static_cast<grc::fmod::Module *>(s)->observe(op, id, text, len, value); } catch (...) {} },
      [](void *s, const uint8_t *h, grc_fmod_buf *b) { return static_cast<grc::fmod::Module *>(s)->take_get(h, b); },
      [](void *s, grc_fmod_buf *b) { return static_cast<grc::fmod::Module *>(s)->take_index(b); },
      [](void *s, void *owner) { static_cast<grc::fmod::Module *>(s)->release(owner); },
      [](void *s) { static_cast<grc::fmod::Module *>(s)->stop(); }
    };
    return 1;
  } catch (...) { return 0; }
}
