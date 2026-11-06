#include "rs_resource_store.h"

#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cerrno>
#include <cstring>

#include "report.h"
#include "rs_http_coding.h"
#include "rs_payload_rest.h"

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
  if (writer_ != nullptr && index_ != nullptr) {
    writer_->drain();  // P3-CAP: every queued payload and index line first
  }
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

ResourceStore::Put ResourceStore::put(const rs2::TextureEntry &entry, const PayloadPtr &payload,
                                      std::uint64_t frame, std::string *error) {
  // render-stream-4.md "Mesh payload": index lines gain "type" (texture-2d | mesh-surface).
  const std::string fields = ",\"type\":\"texture-2d\",\"format\":\"" + entry.format +
                             "\",\"width\":" + std::to_string(entry.width) +
                             ",\"height\":" + std::to_string(entry.height) +
                             ",\"mipmaps\":" + (entry.mipmaps ? "true" : "false");
  return put_bytes(entry.hash, ".grt", fields, payload, frame, error);
}

ResourceStore::Put ResourceStore::put_variant(const rs2::TextureEntry &entry,
                                              const rs2::TextureVariant &variant,
                                              const PayloadPtr &payload,
                                              std::uint64_t frame, std::string *error) {
  if (variant.encoding == rs2::VariantEncoding::Uastc ||
      variant.encoding == rs2::VariantEncoding::Etc1s) {
    // G8ku (render-stream-9.md "KTX2 payload"): `<hash>.ktx2`, the index line naming the encoding
    // and params instead of a format.
    const std::string fields =
        std::string(",\"type\":\"texture-ktx2\",\"encoding\":\"") +
        (variant.encoding == rs2::VariantEncoding::Uastc ? "uastc" : "etc1s") +
        "\",\"params\":\"" + variant.params + "\",\"width\":" + std::to_string(entry.width) +
        ",\"height\":" + std::to_string(entry.height) +
        ",\"mipmaps\":" + (entry.mipmaps ? "true" : "false");
    return put_bytes(variant.hash, ".ktx2", fields, payload, frame, error);
  }
  const std::string fields = ",\"type\":\"texture-2d\",\"format\":\"" + variant.format +
                             "\",\"width\":" + std::to_string(entry.width) +
                             ",\"height\":" + std::to_string(entry.height) +
                             ",\"mipmaps\":" + (entry.mipmaps ? "true" : "false");
  return put_bytes(variant.hash, ".grt", fields, payload, frame, error);
}

ResourceStore::Put ResourceStore::put_mesh(const rs2::MeshSurface &surface,
                                           const PayloadPtr &payload,
                                           std::uint64_t frame, std::string *error) {
  const std::string fields = ",\"type\":\"mesh-surface\",\"primitive\":\"" +
                             std::string(rs2::to_wire(surface.primitive)) +
                             "\",\"format\":" + std::to_string(surface.format) +
                             ",\"vertex_count\":" + std::to_string(surface.vertex_count) +
                             ",\"index_count\":" + std::to_string(surface.index_count);
  return put_bytes(surface.hash, ".grm", fields, payload, frame, error);
}

ResourceStore::Put ResourceStore::put_shader(const rs2::ShaderEntry &shader,
                                             const PayloadPtr &payload_ptr, std::uint64_t frame,
                                             std::string *error) {
  // render-stream-5.md "Shader payload": index lines gain type "shader-code". code_bytes is the
  // payload's own meta value (whole length minus magic, meta length and meta).
  const std::vector<std::uint8_t> &payload = *payload_ptr;
  std::uint64_t code_bytes = 0;
  if (payload.size() >= 12) {
    const std::uint32_t meta_len = static_cast<std::uint32_t>(payload[8]) |
                                   (static_cast<std::uint32_t>(payload[9]) << 8) |
                                   (static_cast<std::uint32_t>(payload[10]) << 16) |
                                   (static_cast<std::uint32_t>(payload[11]) << 24);
    if (12u + meta_len <= payload.size()) {
      code_bytes = payload.size() - 12u - meta_len;
    }
  }
  const std::string fields =
      ",\"type\":\"shader-code\",\"code_bytes\":" + std::to_string(code_bytes);
  return put_bytes(shader.hash, ".grp", fields, payload_ptr, frame, error);
}

ResourceStore::Put ResourceStore::put_bytes(const std::string &hash, const char *extension,
                                            const std::string &index_fields,
                                            const PayloadPtr &payload, std::uint64_t frame,
                                            std::string *error) {
  if (index_ == nullptr) {
    *error = "the resource store is not open";
    return Put::Failed;
  }
  if (hashes_.count(hash) != 0) {
    return Put::Present;
  }
  // wrong-hash: the store's copy differs from the advertised hash in its first data byte. Decided
  // here, on the publishing thread, so corrupted_hash() never races the writer.
  const bool corrupt =
      wrong_hash_frame_ != 0 && frame >= wrong_hash_frame_ && corrupted_.empty();
  if (corrupt) {
    corrupted_ = hash;
  }
  const std::string final_path = path_join(path_join(dir_, "sha256"), hash + extension);
  // TDR: the index and the file are the identity payload's; a body coded at rest is inflated on
  // the writer thread (counted under `store`), never held inflated.
  const std::uint64_t identity_size = payload->identity_size();
  std::string line = "{\"hash\":\"" + hash + "\",\"bytes\":" +
                     std::to_string(identity_size) + index_fields +
                     ",\"first_frame\":" + std::to_string(frame) + "}\n";
  std::FILE *index = index_;
  std::string index_path = path_join(dir_, "index.jsonl");
  auto write = [final_path, payload, corrupt, index, line = std::move(line),
                index_path = std::move(index_path)](std::string *why) {
    const std::shared_ptr<const std::vector<std::uint8_t>> identity =
        identity_of(payload, InflateSite::Store);
    if (identity == nullptr) {
      *why = "cannot inflate the coded body of " + final_path;
      return false;
    }
    return write_payload_file(final_path, *identity, corrupt, index, line, index_path, why);
  };
  if (writer_ != nullptr) {
    // P3-CAP: the I/O runs on the writer thread, in submission order (rs_file_writer.h).
    if (!writer_->submit(std::move(write), identity_size, error)) {
      return Put::Failed;
    }
  } else if (!write(error)) {
    return Put::Failed;
  }
  hashes_.insert(hash);
  bytes_ += identity_size;
  return Put::Stored;
}

bool ResourceStore::write_payload_file(const std::string &final_path,
                                       const std::vector<std::uint8_t> &payload, bool corrupt,
                                       std::FILE *index, const std::string &line,
                                       const std::string &index_path, std::string *error) {
  const std::uint8_t *data = payload.data();
  std::vector<std::uint8_t> corrupted;
  if (corrupt) {
    corrupted = payload;
    const std::size_t offset = first_data_offset(corrupted);
    corrupted[offset] ^= 0xFF;
    data = corrupted.data();
  }
  const std::string temp_path = final_path + ".tmp-" + std::to_string(::getpid());
  std::FILE *file = std::fopen(temp_path.c_str(), "wb");
  if (file == nullptr) {
    *error = "cannot create " + temp_path + ": " + errno_text();
    return false;
  }
  const bool wrote = payload.empty() || std::fwrite(data, 1, payload.size(), file) == payload.size();
  const bool flushed = std::fflush(file) == 0;
  const bool closed = std::fclose(file) == 0;
  if (!wrote || !flushed || !closed) {
    *error = "cannot write " + temp_path + ": " + errno_text();
    std::remove(temp_path.c_str());
    return false;
  }
  if (std::rename(temp_path.c_str(), final_path.c_str()) != 0) {
    *error = "cannot rename " + temp_path + ": " + errno_text();
    std::remove(temp_path.c_str());
    return false;
  }
  if (std::fwrite(line.data(), 1, line.size(), index) != line.size() || std::fflush(index) != 0) {
    *error = "cannot append to " + index_path + ": " + errno_text();
    return false;
  }
  return true;
}

// ----------------------------------------------------------------------------- ServedResources

namespace {

// wrong-hash's served copy: the identity bytes with the first data byte flipped, then (TDR) coded
// at rest again, so a coding GET serves it coded like every other body.
PayloadPtr corrupted_copy(const PayloadPtr &payload) {
  const std::shared_ptr<const std::vector<std::uint8_t>> identity =
      identity_of(payload, InflateSite::Sabotage);
  if (identity == nullptr) {
    return payload;
  }
  auto copy = std::make_shared<PayloadBytes>(std::vector<std::uint8_t>(*identity));
  const std::size_t offset = ResourceStore::first_data_offset(*copy);
  if (offset != 0) {
    (*copy)[offset] ^= 0xFF;
  }
  PayloadPtr out = std::move(copy);
  if (payload->coded()) {
    code_at_rest(&out);
  }
  return out;
}

}  // namespace

void ServedResources::corrupt(const std::string &hash) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (corrupt_ == hash) {
    return;
  }
  corrupt_ = hash;
  const ServedKey key = ServedKey::from(hash);
  const auto it = served_.find(key);
  if (it != served_.end() && it->second != nullptr) {
    bytes_ -= std::min(bytes_, it->second->held_bytes());
    it->second = corrupted_copy(it->second);
    bytes_ += it->second->held_bytes();
  }
}

bool ServedResources::add_locked(const std::string &hash, const PayloadPtr &payload,
                                 std::uint64_t frame, std::vector<ServeEvent> *events) {
  if (payload == nullptr) {
    return false;
  }
  // SERVED-MAP: decode the key once per pin, then insert with it (one tree walk, no string node).
  const ServedKey key = ServedKey::from(hash);
  const auto entry = served_.emplace(key, payload);
  if (!entry.second) {
    return false;
  }
  // P3-SP: `seen_` (every hash ever pinned) only exists for the drop-resource sabotage; without it
  // a long session would keep one string per payload ever published.
  bool sabotage = false;
  if (drop_frame_ != 0 && dropped_.empty() && seen_.insert(hash).second && frame >= drop_frame_) {
    dropped_ = hash;  // drop-resource: retained like any other hash, but answered 404
    dropped_key_ = key;
    sabotage = true;
  }
  if (hash == corrupt_) {
    entry.first->second = corrupted_copy(payload);
  }
  bytes_ += entry.first->second->held_bytes();  // TDR: the bytes held (coded at rest)
  ++totals_.pinned;
  if (events != nullptr) {
    // An event is only a line for the hook log, and it costs the key's spelling back, so it is
    // built only when a reader takes the events (GRC_HOOK_LOG on).
    ServeEvent event;
    event.op = "pin";
    event.hash = hash;
    event.bytes = payload->identity_size();  // the payload's own size, as the entry names it
    event.reason = "current";
    event.sabotage = sabotage;
    events->push_back(std::move(event));
  }
  return true;
}

void ServedResources::set_serve_skip(bool on) {
  std::lock_guard<std::mutex> lock(mutex_);
  serve_skip_ = on;
  if (on) {
    known_valid_ = true;  // the empty set is what is known: the very first map is "changed"
  }
}

void ServedResources::set_shadow(bool on) {
  std::lock_guard<std::mutex> lock(mutex_);
  shadow_ = on;
}

std::string ServedResources::shadow_failure() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return shadow_failure_;
}

bool ServedResources::known_locked(const PayloadMap &map) const {
  if (!known_valid_) {
    return false;
  }
  if (map.same(last_current_)) {
    return true;
  }
  for (const PayloadMap &base : last_bases_) {
    if (map.same(base)) {
      return true;
    }
  }
  for (const PayloadMap &pinned : pinned_) {
    if (map.same(pinned)) {
      return true;
    }
  }
  return false;
}

void ServedResources::add_map_locked(const PayloadMap &map, std::uint64_t frame,
                                     std::vector<ServeEvent> *events) {
  if (known_locked(map)) {
    return;
  }
  if (!known_valid_) {
    for (const auto &entry : map) {
      add_locked(entry.first, entry.second, frame, events);
    }
    return;
  }
  if (!serve_skip_) {
    // Every hash of last_current_ is served, so only the ones it lacks can be missing (in key
    // order, as the full walk adds them).
    diff_shared_maps(
        last_current_, map, [](const PayloadMap::value_type &) {},
        [&](const PayloadMap::value_type &entry) {
          if (add_locked(entry.first, entry.second, frame, events)) {
            extras_.insert(entry.first);
          }
        },
        [](const PayloadMap::value_type &, const PayloadMap::value_type &) {});
  }
  pinned_.push_back(map);
}

void ServedResources::note_max_locked() {
  totals_.retained_max = std::max<std::uint64_t>(totals_.retained_max, served_.size());
  totals_.retained_bytes_max = std::max(totals_.retained_bytes_max, bytes_);
}

void ServedResources::pin(const std::vector<const PayloadMap *> &maps, std::uint64_t frame,
                          std::vector<ServeEvent> *events) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (const PayloadMap *map : maps) {
    if (map != nullptr) {
      add_map_locked(*map, frame, events);
    }
  }
  note_max_locked();
}

void ServedResources::retire(const PayloadMap &current,
                             const std::vector<const PayloadMap *> &bases, std::uint64_t frame,
                             std::vector<ServeEvent> *events) {
  std::lock_guard<std::mutex> lock(mutex_);
  const bool unpin = unpin_frame_ != 0 && frame >= unpin_frame_;
  const bool retain_superseded =
      retain_superseded_frame_ != 0 && frame >= retain_superseded_frame_;
  // Whatever must be retained and is not yet (nothing, after a correct pin()).
  add_map_locked(current, frame, events);
  // P3-SP: the bases are looked up in place (no per-frame set of every base hash).
  if (!unpin) {
    for (const PayloadMap *base : bases) {
      if (base != nullptr) {
        add_map_locked(*base, frame, events);
      }
    }
  }
  const auto in_bases = [&bases](const std::string &hash) {
    for (const PayloadMap *base : bases) {
      if (base != nullptr && base->count(hash) != 0) {
        return true;
      }
    }
    return false;
  };
  note_max_locked();
  if (retain_superseded) {
    // Every hash this host ever pinned stays servable: nothing is retired, so served_ (and its
    // bytes_) only grows for as long as content keeps changing. Deliberately not "capped" in any
    // way -- that is the sabotage.
    known_valid_ = false;
    return;
  }
  const auto retire_one = [&](std::map<ServedKey, PayloadPtr>::iterator it, bool in_base) {
    const std::uint64_t size = it->second != nullptr ? it->second->identity_size() : 0;
    bytes_ -= std::min(bytes_, it->second != nullptr ? it->second->held_bytes() : 0);
    ++totals_.retired;
    if (in_base) {
      ++totals_.retired_unpinned;
    }
    if (events != nullptr) {
      // SERVED-MAP: only a hook log line needs the key's spelling back.
      ServeEvent event;
      event.op = "retire";
      event.hash = it->first.wire();
      event.bytes = size;
      event.reason = in_base ? "unpin" : "superseded";
      events->push_back(std::move(event));
    }
    return served_.erase(it);
  };
  if (!known_valid_ || unpin) {
    for (auto it = served_.begin(); it != served_.end();) {
      const std::string hash = it->first.wire();
      const bool in_current = current.count(hash) != 0;
      const bool in_base = !in_current && in_bases(hash);
      if (in_current || (in_base && !unpin)) {
        ++it;
        continue;
      }
      it = retire_one(it, in_base);
    }
  } else {
    // HC4b: served_ is last_current_, last_bases_ and extras_; what leaves is among the extras
    // and the hashes of those maps that `current` lacks (their differences from it), retired in
    // key order as the full walk retires them.
    std::set<std::string> candidates(extras_.begin(), extras_.end());
    const auto lost = [&candidates](const PayloadMap::value_type &entry) {
      candidates.insert(entry.first);
    };
    const auto none = [](const PayloadMap::value_type &) {};
    const auto both = [](const PayloadMap::value_type &, const PayloadMap::value_type &) {};
    diff_shared_maps(last_current_, current, lost, none, both);
    for (const PayloadMap &old : last_bases_) {
      bool kept = old.same(current);
      for (const PayloadMap *base : bases) {
        kept = kept || (base != nullptr && old.same(*base));
      }
      if (!kept) {
        diff_shared_maps(old, current, lost, none, both);
      }
    }
    for (const std::string &hash : candidates) {
      const auto it = served_.find(ServedKey::from(hash));
      if (it == served_.end() || current.count(hash) != 0 || in_bases(hash)) {
        continue;
      }
      retire_one(it, false);
    }
  }
  if (unpin) {
    known_valid_ = false;  // the unpin sabotage keeps the full walk
  } else {
    known_valid_ = true;
    last_current_ = current;
    last_bases_.clear();
    for (const PayloadMap *base : bases) {
      if (base != nullptr) {
        last_bases_.push_back(*base);
      }
    }
  }
  extras_.clear();
  pinned_.clear();
  if (shadow_ && shadow_failure_.empty() && !unpin && !serve_skip_) {
    // The full walk's retained set: every hash of `current` and of each base.
    std::set<std::string> want;
    for (const auto &entry : current) {
      want.insert(entry.first);
    }
    for (const PayloadMap *base : bases) {
      for (const auto &entry : *base) {
        want.insert(entry.first);
      }
    }
    bool same = want.size() == served_.size();
    auto w = want.begin();
    for (auto it = served_.begin(); same && it != served_.end(); ++it, ++w) {
      same = it->first == ServedKey::from(*w);
    }
    if (!same) {
      shadow_failure_ = "served: the retained set (" + std::to_string(served_.size()) +
                        " hashes) differs from the full walk's (" + std::to_string(want.size()) +
                        ") at frame " + std::to_string(frame);
    }
  }
}

PayloadPtr ServedResources::held_locked(std::string_view hash) const {
  // SERVED-MAP: the GET's key decodes in place; no std::string is built for the probe.
  const auto it = served_.find(ServedKey::from(hash));
  if (it == served_.end() || (!dropped_.empty() && it->first == dropped_key_)) {
    return nullptr;
  }
  return it->second;
}

bool ServedResources::contains(std::string_view hash) {
  std::lock_guard<std::mutex> lock(mutex_);
  return held_locked(hash) != nullptr;
}

std::shared_ptr<const std::vector<std::uint8_t>> ServedResources::lookup(std::string_view hash) {
  PayloadPtr held;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    held = held_locked(hash);
  }
  // TDR: an identity reader of a body coded at rest gets it inflated here, on the caller's thread
  // and outside the mutex (a decompress of bytes in memory, never a texture decode), kept by
  // nobody once served.
  return identity_of(held, InflateSite::Get);
}

std::shared_ptr<const std::vector<std::uint8_t>> ServedResources::lookup_coded(
    std::string_view hash, live::Coding coding) {
  if (coding == live::Coding::Identity) {
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  const PayloadPtr held = held_locked(hash);
  // TDR: the stored body, exactly as it is held, when it is held in `coding`; nothing is ever
  // compressed here (the body was coded where it was built).
  if (held == nullptr || static_cast<std::uint8_t>(held->rest) != static_cast<std::uint8_t>(coding)) {
    return nullptr;
  }
  return held;
}

live::ResourceBody ServedResources::lookup_body(std::string_view hash, live::Coding accepted) {
  PayloadPtr held;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    held = held_locked(hash);
  }
  live::ResourceBody out;
  if (held == nullptr) {
    return out;
  }
  out.identity_bytes = held->identity_size();
  if (accepted != live::Coding::Identity && held->coded() &&
      static_cast<std::uint8_t>(held->rest) == static_cast<std::uint8_t>(accepted)) {
    out.bytes = held;
    out.coding = accepted;
    return out;
  }
  out.bytes = identity_of(held, InflateSite::Get);
  return out;
}

void ServedResources::census(RestCensus *out, std::unordered_set<const void *> *seen) const {
  std::lock_guard<std::mutex> lock(mutex_);
  for (const auto &entry : served_) {
    out->add(entry.second, seen);
  }
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
    out.insert(entry.first.wire());
  }
  return out;
}

std::uint64_t ServedResources::retained_bytes_beyond(
    const std::vector<const PayloadMap *> &known) const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!known_valid_ || serve_skip_ || known.empty() || known[0] == nullptr) {
    return beyond_full_locked(known);
  }
  // HC4b: served_ is last_current_, last_bases_ and extras_ (pin() has not run since the last
  // retire()), so a hash beyond `known` is an extra or a hash of one of those maps that known[0]
  // lacks.
  const PayloadMap &first = *known[0];
  std::set<std::string> candidates(extras_.begin(), extras_.end());
  const auto lost = [&candidates](const PayloadMap::value_type &entry) {
    candidates.insert(entry.first);
  };
  const auto none = [](const PayloadMap::value_type &) {};
  const auto both = [](const PayloadMap::value_type &, const PayloadMap::value_type &) {};
  diff_shared_maps(last_current_, first, lost, none, both);
  for (const PayloadMap &base : last_bases_) {
    diff_shared_maps(base, first, lost, none, both);
  }
  std::uint64_t total = 0;
  for (const std::string &hash : candidates) {
    const auto it = served_.find(ServedKey::from(hash));
    if (it == served_.end() || it->second == nullptr) {
      continue;
    }
    bool held = false;
    for (const PayloadMap *map : known) {
      held = held || (map != nullptr && map->count(hash) != 0);
    }
    if (!held) {
      total += it->second->held_bytes();
    }
  }
  if (shadow_ && shadow_failure_.empty()) {
    const std::uint64_t want = beyond_full_locked(known);
    if (want != total) {
      // const member: the failure is reported through the next retire()'s check instead.
      const_cast<ServedResources *>(this)->shadow_failure_ =
          "budget: the served bytes beyond the current maps (" + std::to_string(total) +
          ") differ from the full walk's (" + std::to_string(want) + ")";
    }
  }
  return total;
}

std::uint64_t ServedResources::beyond_full_locked(
    const std::vector<const PayloadMap *> &known) const {
  std::uint64_t total = 0;
  for (const auto &entry : served_) {
    const std::string hash = entry.first.wire();  // only the full walk needs the spelling
    bool held = false;
    for (const PayloadMap *map : known) {
      if (map != nullptr && map->count(hash) != 0) {
        held = true;
        break;
      }
    }
    if (!held && entry.second != nullptr) {
      total += entry.second->held_bytes();
    }
  }
  return total;
}

PayloadMap ServedResources::retained_payloads() const {
  std::lock_guard<std::mutex> lock(mutex_);
  PayloadMap out;
  for (const auto &entry : served_) {
    out.emplace(entry.first.wire(), entry.second);
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
