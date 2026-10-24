// The persisted host texture cache (texture-delivery-design.md D7, D8; G8kc).
//
// GRC_TEXTURE_CACHE_DIR=<dir> (outside any repository) turns it on, GRC_TEXTURE_CACHE_MAX_BYTES
// bounds the files it keeps (LRU by last use, 0 or unset: unbounded). The layout is the store
// directory's own: `sha256/<hash>.grt|.ktx2` for the bytes and `index-v1.jsonl` mapping each key to
// the variant's hash and size. A key is (source key, encoding, params_id): the source key is the
// SHA-256 of the hooked image as a GRT1 payload in its own format (D7), the encoding one of
// decoded|block|uastc|etc1s, and params_id names the producer and every setting that changes the
// bytes (`engine-decompress/4.5.1` for the host decode, `basisu-1.60/uastc-l2/zstd6/linear` for
// the Basis encoder). The cache is agnostic of what the bytes are.
//
// Rules (D8): encoded bytes are stored, never regenerated; every file is verified against its
// name before it is served; a corrupt file is deleted (with every row that named it) and the
// caller derives and puts it again; index rows are hints, never trusted without the file. With no
// directory set the cache is disabled and the capture behaves exactly as before.
//
// Pure C++17, no engine types: unit-testable without a Godot process (rs_texture_cache_test).
#ifndef GRC_RS_TEXTURE_CACHE_H
#define GRC_RS_TEXTURE_CACHE_H

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace grc {
namespace rs {

struct CacheConfig {
  std::string dir;               // empty: disabled
  std::uint64_t max_bytes = 0;   // 0: unbounded
};

// Parses GRC_TEXTURE_CACHE_DIR / GRC_TEXTURE_CACHE_MAX_BYTES (either may be null). A bad byte
// count, or a max without a dir, returns false with *error naming the variable.
bool parse_cache_config(const char *dir, const char *max_bytes, CacheConfig *out,
                        std::string *error);

struct CacheKey {
  std::string source;    // 64 lowercase hex: SHA-256 of the hooked image as GRT1 (D7)
  std::string encoding;  // decoded | block | uastc | etc1s
  std::string params;    // [A-Za-z0-9._/+-]+
  bool operator<(const CacheKey &o) const {
    if (source != o.source) return source < o.source;
    if (encoding != o.encoding) return encoding < o.encoding;
    return params < o.params;
  }
};

bool cache_key_valid(const CacheKey &key);
bool cache_hash_valid(const std::string &hash);

struct CacheStats {
  std::int64_t hits = 0;
  std::int64_t misses = 0;
  std::int64_t corrupt = 0;   // files that failed verify-against-name, deleted
  std::int64_t puts = 0;
  std::int64_t evicted = 0;   // files removed by the byte budget
  std::int64_t bytes_hit = 0;
  std::int64_t bytes_put = 0;
  std::int64_t entries = 0;   // index rows now
  std::int64_t files = 0;     // distinct files now
  std::int64_t bytes = 0;     // their total size
};

enum class CacheResult { Hit, Miss, Corrupt };

class TextureCache {
 public:
  // Creates the directory layout and loads (and, when it has grown, compacts) the index. False
  // with *error when the directory cannot be used.
  bool open(const CacheConfig &config, std::string *error);
  void close();
  bool enabled() const;

  // The verified bytes for `key`. Hit: *bytes and *hash set (the file's name, equal to the
  // SHA-256 of its content). Corrupt: the file did not match its name (or its recorded size); it
  // and every row naming it are gone and the caller derives the bytes again. Miss: no row, or the
  // file is missing (its row is dropped).
  CacheResult get(const CacheKey &key, std::vector<std::uint8_t> *bytes, std::string *hash);

  // Stores `size` bytes whose SHA-256 is `hash` (the caller's, not recomputed) under `key`, then
  // applies the byte budget. `ext` is "grt" or "ktx2". False when the key, hash or ext is invalid
  // or the files cannot be written (the cache then simply stays cold).
  bool put(const CacheKey &key, const std::string &hash, const std::uint8_t *data,
           std::size_t size, const std::string &ext);

  // Index lookup only (a hint: the file is not read).
  bool has(const CacheKey &key) const;

  CacheStats stats() const;
  std::string dir() const;

 private:
  struct Row {
    std::string hash;
    std::string ext;
    std::uint64_t bytes = 0;
    std::uint64_t use = 0;
  };
  std::string file_path(const std::string &hash, const std::string &ext) const;
  void append_row(const CacheKey &key, const Row &row);
  void append_delete(const CacheKey &key);
  void drop_hash_locked(const std::string &hash);
  void evict_locked(const std::string &keep_hash);
  std::uint64_t total_bytes_locked() const;
  void compact_locked();

  mutable std::mutex mutex_;
  bool enabled_ = false;
  CacheConfig config_;
  std::map<CacheKey, Row> rows_;
  std::uint64_t clock_ = 0;
  std::uint64_t tmp_counter_ = 0;
  std::int64_t lines_ = 0;
  CacheStats stats_;
};

// The capture's process-wide cache (entry.cpp opens it at arm from the environment).
TextureCache &texture_cache();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TEXTURE_CACHE_H
