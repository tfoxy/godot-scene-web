#include "rs_resource_store.h"

#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>

#include "report.h"

namespace grc {
namespace rs {

namespace {

std::string errno_text() { return std::strerror(errno); }

}  // namespace

ResourceStore::~ResourceStore() { close(); }

bool ResourceStore::open(const std::string &dir, std::string *error) {
  close();
  if (dir.empty() || dir[0] != '/') {
    *error = "GRC_RESOURCE_STORE_DIR must be absolute";
    return false;
  }
  if (!make_directories(path_join(dir, "sha256"))) {
    *error = "cannot create " + path_join(dir, "sha256");
    return false;
  }
  const std::string index = path_join(dir, "index.jsonl");
  index_ = std::fopen(index.c_str(), "wb");
  if (index_ == nullptr) {
    *error = "cannot create " + index + ": " + errno_text();
    return false;
  }
  dir_ = dir;
  hashes_.clear();
  bytes_ = 0;
  corrupted_.clear();
  return true;
}

void ResourceStore::close() {
  if (index_ != nullptr) {
    std::fclose(index_);
    index_ = nullptr;
  }
}

std::size_t ResourceStore::first_data_offset(const std::vector<std::uint8_t> &payload) {
  if (payload.size() < 12) {
    return 0;
  }
  const std::uint32_t meta_len = static_cast<std::uint32_t>(payload[8]) |
                                 (static_cast<std::uint32_t>(payload[9]) << 8) |
                                 (static_cast<std::uint32_t>(payload[10]) << 16) |
                                 (static_cast<std::uint32_t>(payload[11]) << 24);
  const std::size_t offset = 8 + 4 + static_cast<std::size_t>(meta_len) + 4;
  return offset < payload.size() ? offset : 0;
}

ResourceStore::Put ResourceStore::put(const rs2::TextureEntry &entry,
                                      const std::vector<std::uint8_t> &payload,
                                      std::uint64_t frame, std::string *error) {
  if (index_ == nullptr) {
    *error = "the resource store is not open";
    return Put::Failed;
  }
  if (hashes_.count(entry.hash) != 0) {
    return Put::Present;
  }
  const std::uint8_t *data = payload.data();
  std::vector<std::uint8_t> corrupted;
  if (wrong_hash_frame_ != 0 && frame >= wrong_hash_frame_ && corrupted_.empty()) {
    // wrong-hash: the store's copy differs from the advertised hash in its first data byte.
    corrupted = payload;
    const std::size_t offset = first_data_offset(corrupted);
    corrupted[offset] ^= 0xFF;
    data = corrupted.data();
    corrupted_ = entry.hash;
  }
  const std::string final_path = path_join(path_join(dir_, "sha256"), entry.hash + ".grt");
  const std::string temp_path = final_path + ".tmp-" + std::to_string(::getpid());
  std::FILE *file = std::fopen(temp_path.c_str(), "wb");
  if (file == nullptr) {
    *error = "cannot create " + temp_path + ": " + errno_text();
    return Put::Failed;
  }
  const bool wrote = payload.empty() || std::fwrite(data, 1, payload.size(), file) == payload.size();
  const bool flushed = std::fflush(file) == 0;
  const bool closed = std::fclose(file) == 0;
  if (!wrote || !flushed || !closed) {
    *error = "cannot write " + temp_path + ": " + errno_text();
    std::remove(temp_path.c_str());
    return Put::Failed;
  }
  if (std::rename(temp_path.c_str(), final_path.c_str()) != 0) {
    *error = "cannot rename " + temp_path + ": " + errno_text();
    std::remove(temp_path.c_str());
    return Put::Failed;
  }
  std::string line = "{\"hash\":\"" + entry.hash + "\",\"bytes\":" + std::to_string(payload.size()) +
                     ",\"format\":\"" + entry.format + "\",\"width\":" +
                     std::to_string(entry.width) + ",\"height\":" + std::to_string(entry.height) +
                     ",\"mipmaps\":" + (entry.mipmaps ? "true" : "false") +
                     ",\"first_frame\":" + std::to_string(frame) + "}\n";
  if (std::fwrite(line.data(), 1, line.size(), index_) != line.size() ||
      std::fflush(index_) != 0) {
    *error = "cannot append to " + path_join(dir_, "index.jsonl") + ": " + errno_text();
    return Put::Failed;
  }
  hashes_.insert(entry.hash);
  bytes_ += payload.size();
  return Put::Stored;
}

// ----------------------------------------------------------------------------- ServedResources

namespace {

PayloadPtr corrupted_copy(const PayloadPtr &payload) {
  auto copy = std::make_shared<std::vector<std::uint8_t>>(*payload);
  const std::size_t offset = ResourceStore::first_data_offset(*copy);
  if (offset != 0) {
    (*copy)[offset] ^= 0xFF;
  }
  return copy;
}

}  // namespace

void ServedResources::corrupt(const std::string &hash) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (corrupt_ == hash) {
    return;
  }
  corrupt_ = hash;
  const auto it = served_.find(hash);
  if (it != served_.end() && it->second != nullptr) {
    it->second = corrupted_copy(it->second);
  }
}

void ServedResources::add_locked(const std::string &hash, const PayloadPtr &payload,
                                 std::uint64_t frame, std::vector<ServeEvent> *events) {
  if (payload == nullptr || served_.count(hash) != 0) {
    return;
  }
  ServeEvent event;
  event.op = "pin";
  event.hash = hash;
  event.bytes = payload->size();
  event.reason = "current";
  if (seen_.insert(hash).second && drop_frame_ != 0 && frame >= drop_frame_ && dropped_.empty()) {
    dropped_ = hash;  // drop-resource: retained like any other hash, but answered 404
    event.sabotage = true;
  }
  served_[hash] = hash == corrupt_ ? corrupted_copy(payload) : payload;
  bytes_ += payload->size();
  ++totals_.pinned;
  if (events != nullptr) {
    events->push_back(std::move(event));
  }
}

void ServedResources::note_max_locked() {
  totals_.retained_max = std::max<std::uint64_t>(totals_.retained_max, served_.size());
  totals_.retained_bytes_max = std::max(totals_.retained_bytes_max, bytes_);
}

void ServedResources::pin(const std::vector<const PayloadMap *> &maps, std::uint64_t frame,
                          std::vector<ServeEvent> *events) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (const PayloadMap *map : maps) {
    if (map == nullptr) {
      continue;
    }
    for (const auto &entry : *map) {
      add_locked(entry.first, entry.second, frame, events);
    }
  }
  note_max_locked();
}

void ServedResources::retire(const PayloadMap &current,
                             const std::vector<const PayloadMap *> &bases, std::uint64_t frame,
                             std::vector<ServeEvent> *events) {
  std::lock_guard<std::mutex> lock(mutex_);
  const bool unpin = unpin_frame_ != 0 && frame >= unpin_frame_;
  // Whatever must be retained and is not yet (nothing, after a correct pin()).
  for (const auto &entry : current) {
    add_locked(entry.first, entry.second, frame, events);
  }
  std::set<std::string> base_hashes;
  for (const PayloadMap *base : bases) {
    if (base == nullptr) {
      continue;
    }
    for (const auto &entry : *base) {
      base_hashes.insert(entry.first);
      if (!unpin) {
        add_locked(entry.first, entry.second, frame, events);
      }
    }
  }
  note_max_locked();
  for (auto it = served_.begin(); it != served_.end();) {
    const bool in_current = current.count(it->first) != 0;
    const bool in_base = base_hashes.count(it->first) != 0;
    if (in_current || (in_base && !unpin)) {
      ++it;
      continue;
    }
    ServeEvent event;
    event.op = "retire";
    event.hash = it->first;
    event.bytes = it->second != nullptr ? it->second->size() : 0;
    event.reason = in_base ? "unpin" : "superseded";
    bytes_ -= std::min(bytes_, event.bytes);
    ++totals_.retired;
    if (in_base) {
      ++totals_.retired_unpinned;
    }
    if (events != nullptr) {
      events->push_back(std::move(event));
    }
    it = served_.erase(it);
  }
}

std::shared_ptr<const std::vector<std::uint8_t>> ServedResources::lookup(std::string_view hash) {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = served_.find(std::string(hash));
  if (it == served_.end() || it->first == dropped_) {
    return nullptr;
  }
  return it->second;
}

std::uint64_t ServedResources::retained() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return served_.size();
}

std::uint64_t ServedResources::retained_bytes() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return bytes_;
}

std::set<std::string> ServedResources::retained_hashes() const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::set<std::string> out;
  for (const auto &entry : served_) {
    out.insert(entry.first);
  }
  return out;
}

PayloadMap ServedResources::retained_payloads() const {
  std::lock_guard<std::mutex> lock(mutex_);
  PayloadMap out;
  for (const auto &entry : served_) {
    out.emplace(entry.first, entry.second);
  }
  return out;
}

ServedResources::Totals ServedResources::totals() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return totals_;
}

std::string ServedResources::dropped_hash() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return dropped_;
}

}  // namespace rs
}  // namespace grc
