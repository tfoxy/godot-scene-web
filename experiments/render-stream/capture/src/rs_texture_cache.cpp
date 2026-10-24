#include "rs_texture_cache.h"

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <unistd.h>

#include "rs_sha256.h"

namespace grc {
namespace rs {

namespace fs = std::filesystem;

namespace {

bool hex64(const std::string &s) {
  if (s.size() != 64) return false;
  for (char c : s) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

bool params_ok(const std::string &s) {
  if (s.empty() || s.size() > 128) return false;
  for (char c : s) {
    const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                    c == '.' || c == '_' || c == '/' || c == '+' || c == '-';
    if (!ok) return false;
  }
  return true;
}

bool encoding_ok(const std::string &s) {
  return s == "decoded" || s == "block" || s == "uastc" || s == "etc1s";
}

bool ext_ok(const std::string &s) { return s == "grt" || s == "ktx2"; }

// The little JSON the index needs: flat objects of strings and non-negative integers, written by
// this file only. Unknown or malformed rows are skipped (index rows are hints).
bool parse_row(const std::string &line, std::map<std::string, std::string> *out) {
  out->clear();
  std::size_t i = 0;
  auto skip = [&]() {
    while (i < line.size() && (line[i] == ' ' || line[i] == '\t')) ++i;
  };
  skip();
  if (i >= line.size() || line[i] != '{') return false;
  ++i;
  while (true) {
    skip();
    if (i < line.size() && line[i] == '}') return true;
    if (i >= line.size() || line[i] != '"') return false;
    const std::size_t k0 = ++i;
    while (i < line.size() && line[i] != '"') ++i;
    if (i >= line.size()) return false;
    const std::string key = line.substr(k0, i - k0);
    ++i;
    skip();
    if (i >= line.size() || line[i] != ':') return false;
    ++i;
    skip();
    std::string value;
    if (i < line.size() && line[i] == '"') {
      const std::size_t v0 = ++i;
      while (i < line.size() && line[i] != '"') ++i;
      if (i >= line.size()) return false;
      value = line.substr(v0, i - v0);
      ++i;
    } else {
      const std::size_t v0 = i;
      while (i < line.size() && line[i] != ',' && line[i] != '}') ++i;
      value = line.substr(v0, i - v0);
      while (!value.empty() && value.back() == ' ') value.pop_back();
    }
    (*out)[key] = value;
    skip();
    if (i < line.size() && line[i] == ',') ++i;
  }
}

bool parse_u64(const std::string &s, std::uint64_t *out) {
  if (s.empty()) return false;
  std::uint64_t v = 0;
  for (char c : s) {
    if (c < '0' || c > '9') return false;
    v = v * 10 + static_cast<std::uint64_t>(c - '0');
  }
  *out = v;
  return true;
}

}  // namespace

bool cache_hash_valid(const std::string &hash) { return hex64(hash); }

bool cache_key_valid(const CacheKey &key) {
  return hex64(key.source) && encoding_ok(key.encoding) && params_ok(key.params);
}

bool parse_cache_config(const char *dir, const char *max_bytes, CacheConfig *out,
                        std::string *error) {
  *out = CacheConfig();
  const std::string d = dir != nullptr ? dir : "";
  const std::string m = max_bytes != nullptr ? max_bytes : "";
  if (!m.empty()) {
    std::uint64_t v = 0;
    if (!parse_u64(m, &v)) {
      *error = "GRC_TEXTURE_CACHE_MAX_BYTES must be a non-negative integer (bytes), got '" + m + "'";
      return false;
    }
    if (d.empty()) {
      *error = "GRC_TEXTURE_CACHE_MAX_BYTES needs GRC_TEXTURE_CACHE_DIR";
      return false;
    }
    out->max_bytes = v;
  }
  out->dir = d;
  return true;
}

std::string TextureCache::file_path(const std::string &hash, const std::string &ext) const {
  return config_.dir + "/sha256/" + hash + "." + ext;
}

bool TextureCache::open(const CacheConfig &config, std::string *error) {
  std::lock_guard<std::mutex> lock(mutex_);
  enabled_ = false;
  rows_.clear();
  stats_ = CacheStats();
  clock_ = 0;
  lines_ = 0;
  config_ = config;
  if (config.dir.empty()) {
    return true;
  }
  std::error_code ec;
  fs::create_directories(fs::path(config.dir) / "sha256", ec);
  if (ec) {
    *error = "GRC_TEXTURE_CACHE_DIR '" + config.dir + "' is not usable: " + ec.message();
    return false;
  }
  const std::string index = config.dir + "/index-v1.jsonl";
  std::ifstream in(index);
  std::string line;
  std::map<std::string, std::string> f;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    ++lines_;
    if (!parse_row(line, &f)) continue;
    CacheKey key{f["source"], f["encoding"], f["params"]};
    if (!cache_key_valid(key)) continue;
    if (f.count("del") != 0) {
      rows_.erase(key);
      continue;
    }
    Row row;
    row.hash = f["hash"];
    row.ext = f["ext"];
    if (!hex64(row.hash) || !ext_ok(row.ext) || !parse_u64(f["bytes"], &row.bytes) ||
        !parse_u64(f["use"], &row.use)) {
      continue;
    }
    clock_ = std::max(clock_, row.use);
    rows_[key] = row;
  }
  enabled_ = true;
  if (lines_ > static_cast<std::int64_t>(rows_.size()) * 2 + 16) {
    compact_locked();
  }
  return true;
}

void TextureCache::close() {
  std::lock_guard<std::mutex> lock(mutex_);
  enabled_ = false;
  rows_.clear();
}

bool TextureCache::enabled() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return enabled_;
}

std::string TextureCache::dir() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return config_.dir;
}

void TextureCache::append_row(const CacheKey &key, const Row &row) {
  std::ofstream out(config_.dir + "/index-v1.jsonl", std::ios::app);
  out << "{\"v\":1,\"source\":\"" << key.source << "\",\"encoding\":\"" << key.encoding
      << "\",\"params\":\"" << key.params << "\",\"hash\":\"" << row.hash << "\",\"bytes\":"
      << row.bytes << ",\"ext\":\"" << row.ext << "\",\"use\":" << row.use << "}\n";
  ++lines_;
}

void TextureCache::append_delete(const CacheKey &key) {
  std::ofstream out(config_.dir + "/index-v1.jsonl", std::ios::app);
  out << "{\"v\":1,\"del\":1,\"source\":\"" << key.source << "\",\"encoding\":\"" << key.encoding
      << "\",\"params\":\"" << key.params << "\"}\n";
  ++lines_;
}

void TextureCache::compact_locked() {
  const std::string index = config_.dir + "/index-v1.jsonl";
  const std::string tmp = index + ".tmp." + std::to_string(::getpid());
  {
    std::ofstream out(tmp, std::ios::trunc);
    for (const auto &kv : rows_) {
      out << "{\"v\":1,\"source\":\"" << kv.first.source << "\",\"encoding\":\""
          << kv.first.encoding << "\",\"params\":\"" << kv.first.params << "\",\"hash\":\""
          << kv.second.hash << "\",\"bytes\":" << kv.second.bytes << ",\"ext\":\""
          << kv.second.ext << "\",\"use\":" << kv.second.use << "}\n";
    }
  }
  std::error_code ec;
  fs::rename(tmp, index, ec);
  if (ec) {
    fs::remove(tmp, ec);
    return;
  }
  lines_ = static_cast<std::int64_t>(rows_.size());
}

// Removes every row naming `hash`, and its file.
void TextureCache::drop_hash_locked(const std::string &hash) {
  std::string ext = "grt";
  std::vector<CacheKey> gone;
  for (const auto &kv : rows_) {
    if (kv.second.hash == hash) {
      ext = kv.second.ext;
      gone.push_back(kv.first);
    }
  }
  for (const CacheKey &key : gone) {
    rows_.erase(key);
    append_delete(key);
  }
  std::error_code ec;
  fs::remove(file_path(hash, ext), ec);
}

std::uint64_t TextureCache::total_bytes_locked() const {
  std::set<std::string> seen;
  std::uint64_t total = 0;
  for (const auto &kv : rows_) {
    if (seen.insert(kv.second.hash).second) total += kv.second.bytes;
  }
  return total;
}

void TextureCache::evict_locked(const std::string &keep_hash) {
  if (config_.max_bytes == 0) return;
  while (total_bytes_locked() > config_.max_bytes) {
    // The least recently used file: a file's recency is the newest use among its rows.
    std::map<std::string, std::uint64_t> newest;
    for (const auto &kv : rows_) {
      auto &u = newest[kv.second.hash];
      u = std::max(u, kv.second.use);
    }
    std::string victim;
    std::uint64_t best = 0;
    for (const auto &kv : newest) {
      if (kv.first == keep_hash) continue;
      if (victim.empty() || kv.second < best) {
        victim = kv.first;
        best = kv.second;
      }
    }
    if (victim.empty()) return;  // only the entry just stored is left: it stays, over budget
    drop_hash_locked(victim);
    ++stats_.evicted;
  }
}

bool TextureCache::has(const CacheKey &key) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return enabled_ && rows_.count(key) != 0;
}

CacheResult TextureCache::get(const CacheKey &key, std::vector<std::uint8_t> *bytes,
                              std::string *hash) {
  Row row;
  std::string path;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!enabled_ || !cache_key_valid(key)) {
      ++stats_.misses;
      return CacheResult::Miss;
    }
    auto it = rows_.find(key);
    if (it == rows_.end()) {
      ++stats_.misses;
      return CacheResult::Miss;
    }
    row = it->second;
    path = file_path(row.hash, row.ext);
  }
  // The read and the verify run outside the lock: workers hit the cache in parallel.
  std::ifstream in(path, std::ios::binary);
  std::vector<std::uint8_t> data;
  const bool present = static_cast<bool>(in);
  if (present) {
    data.assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  }
  const bool good =
      present && data.size() == row.bytes && sha256_hex(data.data(), data.size()) == row.hash;
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = rows_.find(key);
  if (!present) {
    if (it != rows_.end() && it->second.hash == row.hash) {
      rows_.erase(it);
      append_delete(key);
    }
    ++stats_.misses;
    return CacheResult::Miss;
  }
  if (!good) {
    drop_hash_locked(row.hash);
    ++stats_.corrupt;
    return CacheResult::Corrupt;
  }
  if (it != rows_.end() && it->second.hash == row.hash) {
    it->second.use = ++clock_;
    append_row(key, it->second);
  }
  ++stats_.hits;
  stats_.bytes_hit += static_cast<std::int64_t>(data.size());
  *bytes = std::move(data);
  *hash = row.hash;
  return CacheResult::Hit;
}

bool TextureCache::put(const CacheKey &key, const std::string &hash, const std::uint8_t *data,
                       std::size_t size, const std::string &ext) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!enabled_ || !cache_key_valid(key) || !hex64(hash) || !ext_ok(ext) || data == nullptr) {
    return false;
  }
  const std::string path = file_path(hash, ext);
  std::error_code ec;
  if (!fs::exists(path, ec) || fs::file_size(path, ec) != size) {
    const std::string tmp = path + ".tmp." + std::to_string(::getpid()) + "." +
                            std::to_string(++tmp_counter_);
    {
      std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
      out.write(reinterpret_cast<const char *>(data), static_cast<std::streamsize>(size));
      if (!out) {
        out.close();
        fs::remove(tmp, ec);
        return false;
      }
    }
    fs::rename(tmp, path, ec);
    if (ec) {
      fs::remove(tmp, ec);
      return false;
    }
  }
  Row row;
  row.hash = hash;
  row.ext = ext;
  row.bytes = size;
  row.use = ++clock_;
  rows_[key] = row;
  append_row(key, row);
  ++stats_.puts;
  stats_.bytes_put += static_cast<std::int64_t>(size);
  evict_locked(hash);
  return true;
}

CacheStats TextureCache::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  CacheStats s = stats_;
  s.entries = static_cast<std::int64_t>(rows_.size());
  std::set<std::string> files;
  for (const auto &kv : rows_) files.insert(kv.second.hash);
  s.files = static_cast<std::int64_t>(files.size());
  s.bytes = static_cast<std::int64_t>(total_bytes_locked());
  return s;
}

TextureCache &texture_cache() {
  static TextureCache cache;
  return cache;
}

}  // namespace rs
}  // namespace grc
