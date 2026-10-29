// See rs_canvas_texture_shim.h.
#include "rs_canvas_texture_shim.h"

#include <cstring>

#include "report.h"

namespace grc {
namespace rs {

bool parse_canvas_texture_shim_mode(const char *value, CanvasTextureShimMode *out,
                                    std::string *error) {
  if (value == nullptr || std::strcmp(value, "") == 0 || std::strcmp(value, "off") == 0) {
    *out = CanvasTextureShimMode::Off;
    return true;
  }
  if (std::strcmp(value, "synthesize") == 0) {
    *out = CanvasTextureShimMode::Synthesize;
    return true;
  }
  *error = std::string("invalid GRC_HEADLESS_CANVAS_TEXTURE=") + value +
           " (expected off or synthesize)";
  return false;
}

bool headless_defaults_apply(const std::string &display_server, const char *stream_version) {
  if (display_server != "headless" || stream_version == nullptr || *stream_version == '\0') {
    return false;
  }
  long version = 0;
  for (const char *c = stream_version; *c != '\0'; ++c) {
    if (*c < '0' || *c > '9' || version > 1000) {
      return false;
    }
    version = version * 10 + (*c - '0');
  }
  return version >= 12;
}

std::string resolve_headless_default(const char *value, bool defaults_on, const char *on_value,
                                     const char *off_value) {
  if (value != nullptr && std::strcmp(value, "auto") != 0) {
    return value;
  }
  return defaults_on ? on_value : off_value;
}

bool canvas_texture_shim_may_arm(CanvasTextureShimMode mode, const std::string &display_server,
                                 std::string *reason) {
  if (mode == CanvasTextureShimMode::Off || display_server == "headless") {
    return true;
  }
  *reason = "canvas-texture-shim-not-headless";
  return false;
}

bool CanvasTextureShim::is_synthetic(std::uint64_t rid) {
  return (rid >> 32) == kTag && (rid & 0xFFFFFFFFull) >= kIndexBase;
}

void CanvasTextureShim::configure(CanvasTextureShimMode mode, const std::string &display_server) {
  std::lock_guard<std::mutex> lock(mutex_);
  mode_ = mode;
  display_server_ = display_server;
  next_index_ = kIndexBase;
  engine_allocated_ = 0;
  foreign_frees_ = 0;
  entries_.clear();
}

bool CanvasTextureShim::armed() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return mode_ == CanvasTextureShimMode::Synthesize;
}

std::uint64_t CanvasTextureShim::on_create(std::uint64_t engine_rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (mode_ != CanvasTextureShimMode::Synthesize) {
    return engine_rid;
  }
  if (engine_rid != 0) {
    ++engine_allocated_;
    return engine_rid;
  }
  if (next_index_ > 0xFFFFFFFFull) {
    // 2^31 private ids spent: refuse to wrap into the engine's range; the engine keeps RID().
    return engine_rid;
  }
  Entry entry;
  entry.rid = (kTag << 32) | next_index_++;
  entry.created_frame = frame;
  entries_.push_back(entry);
  return entry.rid;
}

void CanvasTextureShim::on_free(std::uint64_t rid, std::uint64_t frame) {
  if (!is_synthetic(rid)) {
    return;
  }
  std::lock_guard<std::mutex> lock(mutex_);
  for (Entry &entry : entries_) {
    if (entry.rid == rid) {
      ++entry.frees;
      if (entry.freed_frame == 0) {
        entry.freed_frame = frame;
      }
      return;
    }
  }
  ++foreign_frees_;
}

std::uint64_t CanvasTextureShim::synthesized() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return entries_.size();
}

std::uint64_t CanvasTextureShim::engine_allocated() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return engine_allocated_;
}

std::uint64_t CanvasTextureShim::live() const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::uint64_t n = 0;
  for (const Entry &entry : entries_) {
    n += entry.frees == 0 ? 1 : 0;
  }
  return n;
}

std::string CanvasTextureShim::evidence_json(const std::string &state,
                                             const std::string &reason) const {
  std::lock_guard<std::mutex> lock(mutex_);
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-canvas-texture-shim/1"));
  json.field("mode", std::string(mode_ == CanvasTextureShimMode::Synthesize ? "synthesize"
                                                                             : "off"));
  json.field("state", state);
  json.field_or_null("reason", reason);
  json.field_or_null("display_server", display_server_);
  json.field("tag", std::to_string(kTag));
  json.field("index_base", static_cast<int64_t>(kIndexBase));
  json.field("engine_allocated", static_cast<int64_t>(engine_allocated_));
  json.field("foreign_frees", static_cast<int64_t>(foreign_frees_));
  json.key("synthesized").array_begin();
  for (const Entry &entry : entries_) {
    json.object_begin();
    json.field("rid", std::to_string(entry.rid));
    json.field("index", static_cast<int64_t>(entry.rid & 0xFFFFFFFFull));
    json.field("created_frame", static_cast<int64_t>(entry.created_frame));
    if (entry.frees == 0) {
      json.field_null("freed_frame");
    } else {
      json.field("freed_frame", static_cast<int64_t>(entry.freed_frame));
    }
    json.field("frees", static_cast<int64_t>(entry.frees));
    json.object_end();
  }
  json.array_end();
  json.object_end();
  return json.take();
}

CanvasTextureShim &canvas_texture_shim() {
  static CanvasTextureShim shim;
  return shim;
}

}  // namespace rs
}  // namespace grc
