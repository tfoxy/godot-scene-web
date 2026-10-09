#include "rs_resource_log.h"

#include "rs_texture_payload.h"

namespace grc {
namespace rs {

namespace {

// Appends a JSON string literal; every value here is an identifier, a decimal
// RID or a hex digest, so only `"` and `\` need escaping.
void append_string(std::string *out, const std::string &value) {
  out->push_back('"');
  for (char c : value) {
    if (c == '"' || c == '\\') {
      out->push_back('\\');
      out->push_back(c);
    } else if (static_cast<unsigned char>(c) < 0x20 || static_cast<unsigned char>(c) > 0x7e) {
      out->push_back('?');
    } else {
      out->push_back(c);
    }
  }
  out->push_back('"');
}

}  // namespace

// One line's values; std::nullopt-like "absent" is encoded by the has_* flags
// and empty strings.
struct ResourceLog::Line {
  std::uint64_t frame = 0;
  std::uint64_t t_ns = 0;
  bool main_thread = true;
  std::string op;
  std::uint64_t id = 0;  // 0 = null
  std::uint64_t by_id = 0;
  std::uint64_t rid = 0;  // 0 = null
  std::uint64_t version = 0;  // 0 = null
  std::string kind;
  std::string status;
  std::string reason;
  const PayloadCopy *payload = nullptr;  // image fields, when present
  std::uint64_t target = 0;
  bool has_target = false;
  std::uint64_t ref_id = 0;
  bool has_value = false;
  std::int64_t value = 0;
  bool has_layer = false;
  std::int64_t layer = 0;
  bool has_root = false;
  bool root = false;
};

void ResourceLog::emit(const Line &l) {
  std::string &o = pending_;
  const auto key = [&o](const char *name) {
    o.push_back(',');
    o.push_back('"');
    o += name;
    o += "\":";
  };
  const auto u64_or_null = [&o](std::uint64_t value) {
    if (value == 0) {
      o += "null";
    } else {
      o += std::to_string(value);
    }
  };
  const auto str_or_null = [&o](const std::string &value) {
    if (value.empty()) {
      o += "null";
    } else {
      append_string(&o, value);
    }
  };
  const auto i64_or_null = [&o](bool present, std::int64_t value) {
    if (present) {
      o += std::to_string(value);
    } else {
      o += "null";
    }
  };
  o += "{\"frame\":" + std::to_string(l.frame);
  key("t_us");
  o += std::to_string(l.t_ns >= t0_ns_ ? (l.t_ns - t0_ns_) / 1000 : 0);
  key("thread");
  append_string(&o, l.main_thread ? "main" : "other");
  key("op");
  append_string(&o, l.op);
  key("id");
  u64_or_null(l.id);
  key("by_id");
  u64_or_null(l.by_id);
  key("rid");
  if (l.rid == 0) {
    o += "null";
  } else {
    append_string(&o, std::to_string(l.rid));
  }
  key("version");
  u64_or_null(l.version);
  key("kind");
  str_or_null(l.kind);
  key("status");
  str_or_null(l.status);
  key("reason");
  str_or_null(l.reason);
  const PayloadCopy *p = l.payload;
  key("format");
  const char *format = p != nullptr ? image_format_name(p->format) : nullptr;
  if (format != nullptr) {
    append_string(&o, format);
  } else {
    o += "null";
  }
  key("width");
  i64_or_null(p != nullptr && p->width >= 0, p != nullptr ? p->width : 0);
  key("height");
  i64_or_null(p != nullptr && p->height >= 0, p != nullptr ? p->height : 0);
  key("mipmaps");
  if (p != nullptr && p->mipmaps_known) {
    o += p->mipmaps ? "true" : "false";
  } else {
    o += "null";
  }
  key("data_bytes");
  i64_or_null(p != nullptr && p->data_bytes >= 0, p != nullptr ? p->data_bytes : 0);
  key("payload_bytes");
  i64_or_null(p != nullptr, p != nullptr ? p->payload_bytes : 0);
  key("hash");
  str_or_null(p != nullptr ? p->hash : std::string());
  key("copy_ns");
  i64_or_null(p != nullptr && p->copy_ns >= 0, p != nullptr ? p->copy_ns : 0);
  key("hash_ns");
  i64_or_null(p != nullptr && p->hash_ns >= 0, p != nullptr ? p->hash_ns : 0);
  key("conn");
  o += "null";
  key("http_status");
  o += "null";
  key("target");
  if (l.has_target) {
    append_string(&o, std::to_string(l.target));
  } else {
    o += "null";
  }
  key("ref_id");
  u64_or_null(l.ref_id);
  key("value");
  i64_or_null(l.has_value, l.value);
  key("layer");
  i64_or_null(l.has_layer, l.layer);
  key("root_viewport");
  if (l.has_root) {
    o += l.root ? "true" : "false";
  } else {
    o += "null";
  }
  o += "}\n";
}

ResourceLog::Entry *ResourceLog::find(std::uint64_t rid) {
  auto it = by_rid_.find(rid);
  return it == by_rid_.end() ? nullptr : &it->second;
}

void ResourceLog::start(std::uint64_t t0_ns, std::uint64_t root_viewport_rid) {
  std::lock_guard<std::mutex> lock(mutex_);
  active_ = true;
  t0_ns_ = t0_ns;
  root_viewport_ = root_viewport_rid;
  next_id_ = 1;
  by_rid_.clear();
  pending_.clear();
  update_unknown_ = 0;
}

void ResourceLog::stop() {
  std::lock_guard<std::mutex> lock(mutex_);
  active_ = false;
}

bool ResourceLog::active() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return active_;
}

namespace {

ResourceLog::Line base_line(const TapContext &ctx, const char *op) {
  ResourceLog::Line line;
  line.frame = ctx.frame;
  line.t_ns = ctx.t_ns;
  line.main_thread = ctx.main_thread;
  line.op = op;
  return line;
}

bool same_shape(const PayloadCopy &a, const PayloadCopy &b) {
  return a.format == b.format && a.width == b.width && a.height == b.height &&
         a.mipmaps_known == b.mipmaps_known && a.mipmaps == b.mipmaps && a.format >= 0 &&
         a.width >= 0 && a.height >= 0;
}

}  // namespace

void ResourceLog::texture_2d_create(const TapContext &ctx, std::uint64_t rid,
                                    const PayloadCopy &copy) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Entry entry;
  entry.id = next_id_++;
  entry.kind = "image";
  entry.version = 1;
  entry.status = copy.status;
  entry.reason = copy.reason;
  entry.payload = copy;
  by_rid_[rid] = entry;
  Line line = base_line(ctx, "texture_2d_create");
  line.id = entry.id;
  line.rid = rid;
  line.version = entry.version;
  line.kind = entry.kind;
  line.status = entry.status;
  line.reason = entry.reason;
  line.payload = &copy;
  emit(line);
}

void ResourceLog::texture_2d_update(const TapContext &ctx, std::uint64_t rid,
                                    const PayloadCopy &copy, int layer) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "texture_2d_update");
  line.rid = rid;
  line.payload = &copy;
  line.has_layer = true;
  line.layer = layer;
  Entry *entry = find(rid);
  if (entry == nullptr) {
    // An update to a texture the capture never saw created changes nothing the
    // stream shows (Q3); it is counted and logged with a null id.
    ++update_unknown_;
    line.reason = "unknown-texture";
    emit(line);
    return;
  }
  entry->version += 1;
  if (layer != 0) {
    entry->status = "unsupported";
    entry->reason = "layered-update";
  } else if (entry->kind != "image" || !same_shape(entry->payload, copy)) {
    entry->status = "unsupported";
    entry->reason = "update-shape-mismatch";
  } else {
    entry->status = copy.status;
    entry->reason = copy.reason;
    entry->payload = copy;
  }
  line.id = entry->id;
  line.version = entry->version;
  line.kind = entry->kind;
  line.status = entry->status;
  line.reason = entry->reason;
  emit(line);
}

void ResourceLog::texture_2d_placeholder_create(const TapContext &ctx, std::uint64_t rid) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Entry entry;
  entry.id = next_id_++;
  entry.kind = "placeholder";
  by_rid_[rid] = entry;
  Line line = base_line(ctx, "texture_2d_placeholder_create");
  line.id = entry.id;
  line.rid = rid;
  line.version = entry.version;
  line.kind = entry.kind;
  line.status = entry.status;
  emit(line);
}

void ResourceLog::texture_replace(const TapContext &ctx, std::uint64_t texture,
                                  std::uint64_t by_texture) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "texture_replace");
  line.rid = texture;
  line.has_target = true;
  line.target = by_texture;
  Entry *t = find(texture);
  Entry *b = find(by_texture);
  if (b != nullptr) {
    line.by_id = b->id;
    line.ref_id = b->id;
  }
  if (texture == by_texture) {
    // A no-op in the engine (texture_storage.cpp:1402-1404).
    if (t != nullptr) {
      line.id = t->id;
      line.version = t->version;
      line.kind = t->kind;
      line.status = t->status;
      line.reason = t->reason;
    }
    emit(line);
    return;
  }
  if (t != nullptr) {
    t->version += 1;
    if (b != nullptr) {
      t->kind = b->kind;
      t->status = b->status;
      t->reason = b->reason;
      t->payload = b->payload;
      t->filter = b->filter;
      t->repeat = b->repeat;
      t->channels = b->channels;
      line.payload = &t->payload;
    } else {
      t->status = "unsupported";
      t->reason = "unknown-texture";
    }
    line.id = t->id;
    line.version = t->version;
    line.kind = t->kind;
    line.status = t->status;
    line.reason = t->reason;
  }
  // The engine frees the by-texture itself, without a free call
  // (texture_storage.cpp:1434): its id leaves the registry here.
  if (b != nullptr) {
    by_rid_.erase(by_texture);
  }
  emit(line);
}

void ResourceLog::free_rid(const TapContext &ctx, std::uint64_t rid) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Entry *entry = find(rid);
  if (entry == nullptr) {
    return;
  }
  Line line = base_line(ctx, "free");
  line.id = entry->id;
  line.rid = rid;
  line.version = entry->version;
  line.kind = entry->kind;
  line.status = "freed";
  emit(line);
  by_rid_.erase(rid);
}

void ResourceLog::canvas_texture_create(const TapContext &ctx, std::uint64_t rid) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Entry entry;
  entry.id = next_id_++;
  entry.kind = "canvas";
  by_rid_[rid] = entry;
  Line line = base_line(ctx, "canvas_texture_create");
  line.id = entry.id;
  line.rid = rid;
  line.version = entry.version;
  line.kind = entry.kind;
  line.status = entry.status;
  emit(line);
}

void ResourceLog::canvas_texture_set_channel(const TapContext &ctx, std::uint64_t canvas_texture,
                                             std::int32_t channel, std::uint64_t texture) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_texture_set_channel");
  line.rid = canvas_texture;
  line.has_target = true;
  line.target = texture;
  line.has_value = true;
  line.value = channel;
  if (const Entry *tex = find(texture)) {
    line.ref_id = tex->id;
  }
  Entry *ct = find(canvas_texture);
  if (ct != nullptr) {
    auto it = ct->channels.find(channel);
    const std::uint64_t old = it == ct->channels.end() ? 0 : it->second;
    if (old != texture) {
      ct->channels[channel] = texture;
      ct->version += 1;
    }
    line.id = ct->id;
    line.version = ct->version;
    line.kind = ct->kind;
    line.status = ct->status;
  }
  emit(line);
}

void ResourceLog::canvas_texture_set_filter(const TapContext &ctx, std::uint64_t canvas_texture,
                                            std::int32_t filter) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_texture_set_texture_filter");
  line.rid = canvas_texture;
  line.has_value = true;
  line.value = filter;
  Entry *ct = find(canvas_texture);
  if (ct != nullptr) {
    if (ct->filter != filter) {
      ct->filter = filter;
      ct->version += 1;
    }
    line.id = ct->id;
    line.version = ct->version;
    line.kind = ct->kind;
    line.status = ct->status;
  }
  emit(line);
}

void ResourceLog::canvas_texture_set_repeat(const TapContext &ctx, std::uint64_t canvas_texture,
                                            std::int32_t repeat) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_texture_set_texture_repeat");
  line.rid = canvas_texture;
  line.has_value = true;
  line.value = repeat;
  Entry *ct = find(canvas_texture);
  if (ct != nullptr) {
    if (ct->repeat != repeat) {
      ct->repeat = repeat;
      ct->version += 1;
    }
    line.id = ct->id;
    line.version = ct->version;
    line.kind = ct->kind;
    line.status = ct->status;
  }
  emit(line);
}

void ResourceLog::canvas_item_set_default_texture_filter(const TapContext &ctx,
                                                         std::uint64_t item, std::int32_t filter) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_item_set_default_texture_filter");
  line.has_target = true;
  line.target = item;
  line.has_value = true;
  line.value = filter;
  emit(line);
}

void ResourceLog::canvas_item_set_default_texture_repeat(const TapContext &ctx,
                                                         std::uint64_t item, std::int32_t repeat) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_item_set_default_texture_repeat");
  line.has_target = true;
  line.target = item;
  line.has_value = true;
  line.value = repeat;
  emit(line);
}

void ResourceLog::viewport_set_default_texture_filter(const TapContext &ctx,
                                                      std::uint64_t viewport,
                                                      std::int32_t filter) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "viewport_set_default_canvas_item_texture_filter");
  line.has_target = true;
  line.target = viewport;
  line.has_value = true;
  line.value = filter;
  line.has_root = true;
  line.root = viewport != 0 && viewport == root_viewport_;
  emit(line);
}

void ResourceLog::viewport_set_default_texture_repeat(const TapContext &ctx,
                                                      std::uint64_t viewport,
                                                      std::int32_t repeat) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "viewport_set_default_canvas_item_texture_repeat");
  line.has_target = true;
  line.target = viewport;
  line.has_value = true;
  line.value = repeat;
  line.has_root = true;
  line.root = viewport != 0 && viewport == root_viewport_;
  emit(line);
}

std::uint64_t ResourceLog::texture_id(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = by_rid_.find(rid);
  return it == by_rid_.end() ? 0 : it->second.id;
}

std::string ResourceLog::take_lines() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::string out;
  out.swap(pending_);
  return out;
}

std::uint64_t ResourceLog::update_unknown() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return update_unknown_;
}

ResourceLog &resource_log() {
  static ResourceLog log;
  return log;
}

}  // namespace rs
}  // namespace grc
