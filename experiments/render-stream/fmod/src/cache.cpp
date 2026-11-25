#include "cache.hpp"
#include "rs_audio_wire.h"
#include "rs_sha256.h"
#include <filesystem>
#include <fstream>
#include <limits>
#include <stdexcept>
namespace grc::fmod {
namespace fs = std::filesystem;
namespace {
bool digest(const std::string &s, std::size_t n) {
  return s.size() == n && s.find_first_not_of("0123456789abcdef") == std::string::npos;
}
SharedTake unavailable(const char *reason) {
  auto result = std::make_shared<Take>(); result->reason = reason; return result;
}
}
TakeCache::TakeCache(std::string bankset, std::size_t limit, std::string directory)
  : bankset_(std::move(bankset)), directory_(std::move(directory)), limit_(limit) {
  if (!digest(bankset_, 32)) throw std::runtime_error("create");
  if (!directory_.empty()) {
    std::error_code ec;
    for (fs::directory_iterator it(fs::path(directory_) / bankset_, ec), end; !ec && it != end; it.increment(ec))
      if (it->path().extension() == ".wav" && digest(it->path().stem().string(), 32))
        read_disk(it->path().stem().string());
  }
}
void TakeCache::remember(const std::string &key, SharedTake take) {
  if (take->wav.size() > limit_) return;
  auto old = entries_.find(key);
  if (old != entries_.end()) {
    bytes_ -= old->second.take->wav.size(); order_.erase(old->second.order); entries_.erase(old);
  }
  order_.push_front(key); bytes_ += take->wav.size(); entries_[key] = {std::move(take), order_.begin()};
  while (bytes_ > limit_) {
    auto found = entries_.find(order_.back()); bytes_ -= found->second.take->wav.size();
    entries_.erase(found); order_.pop_back();
  }
}
SharedTake TakeCache::find(const std::string &key) {
  std::lock_guard lock(mutex_);
  auto found = entries_.find(key);
  if (found != entries_.end()) {
    order_.splice(order_.begin(), order_, found->second.order); return found->second.take;
  }
  if (directory_.empty()) return {};
  auto take = read_disk(grc::audio::key_id(key));
  if (take) remember(key, take);
  return take;
}
SharedTake TakeCache::read_disk(const std::string &id) {
  const auto path = fs::path(directory_) / bankset_ / (id + ".wav");
  std::error_code ec; const auto size = fs::file_size(path, ec);
  if (ec || size < 48 || size > 480000 * 4 + 44 || (size - 44) % 4) return {};
  auto take = std::make_shared<Take>(); take->wav.resize(size);
  std::ifstream file(path, std::ios::binary);
  if (!file.read(reinterpret_cast<char *>(take->wav.data()), size)) return {};
  const auto &w = take->wav;
  auto u32 = [&](unsigned n) { return unsigned(w[n]) | unsigned(w[n+1]) << 8 | unsigned(w[n+2]) << 16 | unsigned(w[n+3]) << 24; };
  if (std::string(w.begin(), w.begin()+4) != "RIFF" || u32(4) != size - 8 ||
      std::string(w.begin()+8, w.begin()+16) != "WAVEfmt " || u32(16) != 16 ||
      u32(20) != 0x00020001 || u32(24) != 48000 || u32(28) != 192000 ||
      u32(32) != 0x00100004 || std::string(w.begin()+36,w.begin()+40) != "data" || u32(40) != size-44) return {};
  take->frames = (size - 44) / 4; take->hash = grc::sha256_hex(w.data(), w.size());
  disk_[take->hash] = id; return take;
}
void TakeCache::put(const std::string &key, SharedTake take) {
  if (!take || !take->reason.empty() || !take->frames || take->frames > 480000 ||
      take->wav.size() != take->frames * 4 + 44 || !digest(take->hash, 64)) return;
  std::lock_guard lock(mutex_);
  remember(key, take);
  if (directory_.empty()) return;
  std::error_code ec; auto directory = fs::path(directory_) / bankset_;
  fs::create_directories(directory, ec); if (ec) return;
  const auto path = directory / (grc::audio::key_id(key) + ".wav");
  auto temp = path; temp += ".tmp";
  { std::ofstream file(temp, std::ios::binary | std::ios::trunc);
    file.write(reinterpret_cast<const char *>(take->wav.data()), take->wav.size());
    if (!file) { fs::remove(temp, ec); return; }
  }
  fs::rename(temp, path, ec); if (ec) fs::remove(temp, ec);
  else disk_[take->hash] = grc::audio::key_id(key);
}
SharedTake TakeCache::hash(const std::string &hash) {
  std::lock_guard lock(mutex_);
  for (auto &[key, entry] : entries_) if (entry.take->hash == hash) return entry.take;
  auto found = disk_.find(hash);
  return found != disk_.end() ? read_disk(found->second) : SharedTake{};
}
std::shared_ptr<const Bytes> TakeCache::index() {
  std::lock_guard lock(mutex_);
  std::string json = "{\"bankset\":\"" + bankset_ + "\",\"hashes\":[";
  std::map<std::string, bool> hashes;
  for (const auto &[key, entry] : entries_) hashes[entry.take->hash] = true;
  for (const auto &[hash, key] : disk_) hashes[hash] = true;
  bool comma = false;
  for (const auto &[hash, unused] : hashes) { if (comma) json += ','; comma = true; json += '"' + hash + '"'; }
  json += "]}"; return std::make_shared<const Bytes>(json.begin(), json.end());
}
std::size_t TakeCache::bytes() const { std::lock_guard lock(mutex_); return bytes_; }
int Buffers::lend(std::shared_ptr<const Bytes> data, grc_fmod_buf *out) {
  if (!out) return -1;
  *out = {}; if (!data) return 0;
  std::lock_guard lock(mutex_);
  if (next_ == std::numeric_limits<std::uintptr_t>::max()) return -1;
  const auto id = next_++; live_.emplace(id, data);
  *out = {data->data(), data->size(), reinterpret_cast<void *>(id)}; return 1;
}
void Buffers::release(void *token) {
  std::lock_guard lock(mutex_);
  if (!live_.erase(reinterpret_cast<std::uintptr_t>(token))) ++unknown_;
}
std::uint64_t Buffers::unknown() const { std::lock_guard lock(mutex_); return unknown_; }
TakePool::TakePool(RenderConfig config, unsigned workers, std::shared_ptr<TakeCache> cache,
                   std::function<void(const std::string &)> failure, Render render)
  : config_(std::move(config)), cache_(std::move(cache)), failure_(std::move(failure)), test_render_(std::move(render)) {
  if (workers < 1 || workers > 2) throw std::runtime_error("create");
  try { for (unsigned i = 0; i < workers; ++i) workers_.emplace_back([this] { run(); }); }
  catch (...) { stop(); for (auto &worker : workers_) worker.join(); throw; }
}
TakePool::~TakePool() { stop(); for (auto &worker : workers_) worker.join(); }
void TakePool::stop() { std::lock_guard lock(mutex_); stopping_ = true; changed_.notify_all(); }
void TakePool::request(std::string key, Done done) {
  std::lock_guard lock(mutex_);
  if (stopping_) return;
  auto [entry, inserted] = pending_.try_emplace(key);
  entry->second.push_back(std::move(done));
  if (inserted) { queue_.push_back(std::move(key)); changed_.notify_one(); }
}
void TakePool::run() {
  std::unique_ptr<TakeSystem> system;
  for (;;) {
    std::string key;
    {
      std::unique_lock lock(mutex_); changed_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (stopping_) return;
      key = std::move(queue_.front()); queue_.pop_front();
    }
    SharedTake result;
    try {
      result = cache_->find(key);
      if (!result) {
        if (!test_render_ && !system) system = std::make_unique<TakeSystem>(config_);
        auto take = std::make_shared<Take>(test_render_ ? test_render_(key) : system->render(key));
        // Only one canonical byte array lives in the shared cache.
        Bytes().swap(take->pcm); result = take; cache_->put(key, result);
      }
    } catch (const std::exception &error) { result = unavailable("fmod-off"); failure_(error.what()); }
      catch (...) { result = unavailable("fmod-off"); failure_("create"); }
    std::vector<Done> listeners;
    {
      std::lock_guard lock(mutex_);
      listeners = std::move(pending_.at(key)); pending_.erase(key);
      if (stopping_) return;
    }
    for (auto &listener : listeners) {
      try { listener(result); } catch (...) { failure_("link-down"); }
    }
  }
}
}
