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
//
// ServedResources (G2c2; gate2-design.md D7, Q4 "Live: server, store and pins", "Pinning bound,
// checked from the log"; render-stream-2.md "HTTP (live)") is the live serving side: the set of
// payloads a live host answers `GET <http_path><hash>` with, as the rs_ws ResourceSource. A hash
// is retained (servable) while it is in the current captured state (the published snapshot's
// payloads) or in the last transaction sent on some connection (that connection's base); every
// other hash is retired, and its bytes released, at the end of the frame callback. Two phases per
// callback, so a receiver can never ask for a hash before it is servable:
//   1. pin()     before the live hub sends anything: every payload the hub may send this callback
//                (the published snapshot, and a stale-coalesce copy) becomes servable;
//   2. retire()  after the sends: retained := current ∪ ⋃ bases exactly; the rest is retired.
// The bytes are the shared payload pointers the mirror copied at the hook, never copied again
// (wrong-hash's corrupted copy excepted). Sabotages: `unpin` (from its frame on, retire() ignores
// the bases), `drop-resource` (the first hash first pinned at or after its frame answers 404
// while retained) and `wrong-hash` (corrupt(): that hash is served with its first data byte
// flipped, the same bytes the store directory holds). lookup() runs on the server's I/O thread
// and only takes this object's own mutex; everything else runs on the main thread.
#ifndef GRC_RS_RESOURCE_STORE_H
#define GRC_RS_RESOURCE_STORE_H

#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "rs2_snapshot.h"
#include "rs_captured.h"
#include "rs_ws.h"

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

// One change to the servable set, for the hook log (rs_resource_log.h serve_event).
struct ServeEvent {
  const char *op = "pin";  // "pin" | "retire"
  std::string hash;
  std::uint64_t bytes = 0;
  const char *reason = "";  // pin: "current"; retire: "superseded" | "unpin"
  bool sabotage = false;    // drop-resource's pin of the dropped hash
};

class ServedResources : public live::ResourceSource {
 public:
  ServedResources() = default;
  ServedResources(const ServedResources &) = delete;
  ServedResources &operator=(const ServedResources &) = delete;

  // Sabotage frames (0: off).
  void set_unpin_frame(std::uint64_t frame) { unpin_frame_ = frame; }
  void set_drop_frame(std::uint64_t frame) { drop_frame_ = frame; }
  // wrong-hash: from now on `hash` is served with its first data byte flipped.
  void corrupt(const std::string &hash);

  // Phase 1: every payload of `maps` becomes servable (reason "current"). Appends the new pins.
  void pin(const std::vector<const PayloadMap *> &maps, std::uint64_t frame,
           std::vector<ServeEvent> *events);
  // Phase 2: retained := `current` ∪ every base in `bases` (only `current` once the unpin
  // sabotage's frame is reached); everything else is retired. Appends the pins and retirements.
  void retire(const PayloadMap &current, const std::vector<const PayloadMap *> &bases,
              std::uint64_t frame, std::vector<ServeEvent> *events);

  // I/O thread: the bytes to serve for `hash`, or null (404).
  std::shared_ptr<const std::vector<std::uint8_t>> lookup(std::string_view hash) override;

  // Any thread (locked).
  std::uint64_t retained() const;
  std::uint64_t retained_bytes() const;
  std::set<std::string> retained_hashes() const;
  // The bytes every retained hash holds (budget accounting).
  PayloadMap retained_payloads() const;
  struct Totals {
    std::uint64_t pinned = 0;            // pin events
    std::uint64_t retired = 0;           // retire events
    std::uint64_t retired_unpinned = 0;  // of which the unpin sabotage forced
    std::uint64_t retained_max = 0;
    std::uint64_t retained_bytes_max = 0;
  };
  Totals totals() const;
  std::string dropped_hash() const;

 private:
  void add_locked(const std::string &hash, const PayloadPtr &payload, std::uint64_t frame,
                  std::vector<ServeEvent> *events);
  void note_max_locked();

  mutable std::mutex mutex_;
  std::map<std::string, PayloadPtr> served_;  // retained hash -> the bytes it is served with
  std::set<std::string> seen_;                // every hash ever pinned (drop-resource)
  std::uint64_t bytes_ = 0;
  std::uint64_t unpin_frame_ = 0;
  std::uint64_t drop_frame_ = 0;
  std::string dropped_;
  std::string corrupt_;
  Totals totals_;
};

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_RESOURCE_STORE_H
