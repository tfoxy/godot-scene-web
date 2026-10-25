#include "rs_resource_store.h"

#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cerrno>
#include <cstring>

#include "report.h"
#include "rs_http_coding.h"

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
  std::string line = "{\"hash\":\"" + hash + "\",\"bytes\":" +
                     std::to_string(payload->size()) + index_fields +
                     ",\"first_frame\":" + std::to_string(frame) + "}\n";
  std::FILE *index = index_;
  std::string index_path = path_join(dir_, "index.jsonl");
  auto write = [final_path, payload, corrupt, index, line = std::move(line),
                index_path = std::move(index_path)](std::string *why) {
    return write_payload_file(final_path, *payload, corrupt, index, line, index_path, why);
  };
  if (writer_ != nullptr) {
    // P3-CAP: the I/O runs on the writer thread, in submission order (rs_file_writer.h).
    if (!writer_->submit(std::move(write), payload->size(), error)) {
      return Put::Failed;
    }
  } else if (!write(error)) {
    return Put::Failed;
  }
  hashes_.insert(hash);
  bytes_ += payload->size();
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
  coded_.erase(hash);
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
  const bool retain_superseded =
      retain_superseded_frame_ != 0 && frame >= retain_superseded_frame_;
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
  if (retain_superseded) {
    // Every hash this host ever pinned stays servable: nothing is retired, so served_ (and its
    // bytes_) only grows for as long as content keeps changing. Deliberately not "capped" in any
    // way -- that is the sabotage.
    return;
  }
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
    coded_.erase(it->first);
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

std::shared_ptr<const std::vector<std::uint8_t>> ServedResources::lookup_coded(
    std::string_view hash, live::Coding coding) {
  if (coding == live::Coding::Identity) {
    return nullptr;
  }
  const std::size_t slot = static_cast<std::size_t>(coding);
  PayloadPtr identity;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto it = served_.find(std::string(hash));
    if (it == served_.end() || it->first == dropped_ || it->second == nullptr) {
      return nullptr;
    }
    const auto coded = coded_.find(it->first);
    if (coded != coded_.end() && coded->second.tried[slot]) {
      return coded->second.body[slot];
    }
    identity = it->second;
  }
  // Texture payloads only (render-stream-2.md "HTTP (live)": a mesh or shader payload, and any
  // short body, is served as is).
  static const std::uint8_t kGrt1[8] = {0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A};
  PayloadPtr result;
  std::uint64_t spent_ns = 0;
  if (identity->size() > sizeof(kGrt1) + 64 && std::equal(kGrt1, kGrt1 + 8, identity->begin())) {
    std::vector<std::uint8_t> out;
    const auto start = std::chrono::steady_clock::now();
    const bool ok = coding == live::Coding::Zstd
                        ? http_coding::zstd_compress(identity->data(), identity->size(), &out)
                        : http_coding::gzip_compress(identity->data(), identity->size(), &out);
    spent_ns = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - start)
            .count());
    if (ok && out.size() < identity->size()) {
      result = std::make_shared<const std::vector<std::uint8_t>>(std::move(out));
    }
  }
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = served_.find(std::string(hash));
  if (it == served_.end() || it->second != identity) {
    return result;  // retired or replaced while compressing: serve this once, keep nothing
  }
  CodedBodies &kept = coded_[it->first];
  kept.tried[slot] = true;
  kept.body[slot] = result;
  if (result != nullptr) {
    ++totals_.coded_made;
    totals_.coded_in_bytes += identity->size();
    totals_.coded_out_bytes += result->size();
  }
  totals_.coded_ns += spent_ns;
  return result;
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

std::uint64_t ServedResources::retained_bytes_beyond(
    const std::vector<const PayloadMap *> &known) const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::uint64_t total = 0;
  for (const auto &entry : served_) {
    bool held = false;
    for (const PayloadMap *map : known) {
      if (map != nullptr && map->count(entry.first) != 0) {
        held = true;
        break;
      }
    }
    if (!held && entry.second != nullptr) {
      total += entry.second->size();
    }
  }
  return total;
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
