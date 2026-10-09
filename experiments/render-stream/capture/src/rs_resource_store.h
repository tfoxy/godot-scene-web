// The content-addressed resource store directory (gate 2, G2b2; gate2-design.md D6, Q4 "File
// sinks"; render-stream-2.md "Store directory (file recordings)").
//
//   <dir>/sha256/<hash>.grt     one render-stream-texture/1 payload per hash, written once
//                               (temporary file + rename)
//   <dir>/index.jsonl           {"hash","bytes","format","width","height","mipmaps","first_frame"}
//                               per hash, in the order they were stored
//
// The publisher (rs_publish.h) puts every `ok` image hash of each published snapshot that the
// store lacks. A write failure is the caller's sticky `resource-store-failed`.
//
// The `wrong-hash` sabotage lives here: the first hash first stored at or after the sabotage
// frame is written with its first data byte flipped, under its true name, so a receiver that
// verifies the SHA-256 against the name refuses it (`resource-hash-mismatch`). G2c2 serves the
// same corrupted copy over HTTP.
//
// Engine-free; main thread only (the frame callback), no lock.
#ifndef GRC_RS_RESOURCE_STORE_H
#define GRC_RS_RESOURCE_STORE_H

#include <cstdint>
#include <cstdio>
#include <set>
#include <string>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs {

class ResourceStore {
 public:
  ResourceStore() = default;
  ~ResourceStore();
  ResourceStore(const ResourceStore &) = delete;
  ResourceStore &operator=(const ResourceStore &) = delete;

  // Creates `dir/sha256/` and truncates `dir/index.jsonl`. `dir` must be absolute.
  bool open(const std::string &dir, std::string *error);
  void close();
  bool is_open() const { return index_ != nullptr; }
  const std::string &dir() const { return dir_; }

  // wrong-hash sabotage: corrupt the first payload first stored at or after `frame` (0: off).
  void set_wrong_hash_frame(std::uint64_t frame) { wrong_hash_frame_ = frame; }

  enum class Put : std::uint8_t { Stored, Present, Failed };
  // Stores `payload` (a complete GRT1 payload whose SHA-256 is `entry.hash`) unless the store
  // already holds that hash. `entry` supplies the index line's shape.
  Put put(const rs2::TextureEntry &entry, const std::vector<std::uint8_t> &payload,
          std::uint64_t frame, std::string *error);

  bool has(const std::string &hash) const { return hashes_.count(hash) != 0; }
  std::uint64_t hashes() const { return hashes_.size(); }
  std::uint64_t bytes() const { return bytes_; }
  // The hash the wrong-hash sabotage corrupted, or "".
  const std::string &corrupted_hash() const { return corrupted_; }

  // The offset of a GRT1 payload's first data byte (magic, meta length, meta, data length), or
  // 0 when the payload is too short to say.
  static std::size_t first_data_offset(const std::vector<std::uint8_t> &payload);

 private:
  std::string dir_;
  std::FILE *index_ = nullptr;
  std::set<std::string> hashes_;
  std::uint64_t bytes_ = 0;
  std::uint64_t wrong_hash_frame_ = 0;
  std::string corrupted_;
};

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_RESOURCE_STORE_H
