#include "rs_resource_store.h"

#include <unistd.h>

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

}  // namespace rs
}  // namespace grc
