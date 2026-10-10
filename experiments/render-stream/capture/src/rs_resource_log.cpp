#include "rs_resource_log.h"

#include "rs_mesh_payload.h"
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
  bool sabotage = false;
  bool omitted = false;
  std::uint64_t conn = 0;  // 0 = null
  std::int64_t http_status = -1;  // -1 = null (G2c2: http-get lines)
  // G5a (gate5-design.md Q3d): mesh fields, present only on a kind:"mesh" line. `format` and
  // `hash`/`copy_ns`/`hash_ns` share the texture columns above (never both present on one line);
  // everything below is new, trailing columns.
  const MeshSurfaceCopy *mesh_payload = nullptr;
  bool has_surface = false;
  std::int32_t surface = 0;
  std::string buffer;    // "vertex" | "attribute" | "skin" | "index"
  bool has_offset = false;
  std::int32_t offset = 0;
  bool has_bytes = false;
  std::int64_t bytes = 0;
  std::string outcome;   // "applied" | "rejected" | "unknown"
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
  const MeshSurfaceCopy *mp = l.mesh_payload;
  key("format");
  const char *format = p != nullptr ? image_format_name(p->format) : nullptr;
  if (format != nullptr) {
    append_string(&o, format);
  } else if (mp != nullptr) {
    o += std::to_string(mp->format);
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
  str_or_null(p != nullptr ? p->hash : (mp != nullptr ? mp->hash : std::string()));
  key("copy_ns");
  if (p != nullptr) {
    i64_or_null(p->copy_ns >= 0, p->copy_ns);
  } else {
    i64_or_null(mp != nullptr && mp->copy_ns >= 0, mp != nullptr ? mp->copy_ns : 0);
  }
  key("hash_ns");
  if (p != nullptr) {
    i64_or_null(p->hash_ns >= 0, p->hash_ns);
  } else {
    i64_or_null(mp != nullptr && mp->hash_ns >= 0, mp != nullptr ? mp->hash_ns : 0);
  }
  key("conn");
  u64_or_null(l.conn);
  key("http_status");
  i64_or_null(l.http_status >= 0, l.http_status);
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
  // G5a (gate5-design.md Q3d): mesh-only trailing columns, null on every other line.
  key("surface");
  i64_or_null(l.has_surface, l.surface);
  key("buffer");
  str_or_null(l.buffer);
  key("offset");
  i64_or_null(l.has_offset, l.offset);
  key("bytes");
  i64_or_null(l.has_bytes, l.bytes);
  key("primitive");
  const char *primitive = mp != nullptr ? mesh_primitive_name(mp->primitive) : nullptr;
  str_or_null(primitive != nullptr ? std::string(primitive) : std::string());
  key("vertex_count");
  i64_or_null(mp != nullptr && mp->vertex_count >= 0, mp != nullptr ? mp->vertex_count : 0);
  key("index_count");
  i64_or_null(mp != nullptr && mp->index_count >= 0, mp != nullptr ? mp->index_count : 0);
  key("outcome");
  str_or_null(l.outcome);
  // G2b2: present only on a sabotage's own lines (spurious-texture-update's version bump; an
  // op the omit-op sabotage left out of the registry, `omitted`).
  if (l.sabotage) {
    o += ",\"sabotage\":true";
  }
  if (l.omitted) {
    o += ",\"omitted\":true";
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
  next_mesh_id_ = 1;
  mesh_by_rid_.clear();
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
                                    const PayloadCopy &copy, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  if (omitted) {
    Line line = base_line(ctx, "texture_2d_create");
    line.rid = rid;
    line.payload = &copy;
    line.sabotage = true;
    line.omitted = true;
    emit(line);
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
                                    const PayloadCopy &copy, int layer, bool omitted) {
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
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
    if (entry != nullptr) {
      line.id = entry->id;
      line.version = entry->version;
      line.kind = entry->kind;
      line.status = entry->status;
      line.reason = entry->reason;
    }
    emit(line);
    return;
  }
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

void ResourceLog::texture_2d_placeholder_create(const TapContext &ctx, std::uint64_t rid,
                                                bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  if (omitted) {
    Line line = base_line(ctx, "texture_2d_placeholder_create");
    line.rid = rid;
    line.sabotage = true;
    line.omitted = true;
    emit(line);
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
                                  std::uint64_t by_texture, bool omitted) {
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
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
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

void ResourceLog::free_rid(const TapContext &ctx, std::uint64_t rid, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Entry *entry = find(rid);
  if (entry != nullptr) {
    Line line = base_line(ctx, "free");
    line.id = entry->id;
    line.rid = rid;
    line.version = entry->version;
    line.kind = entry->kind;
    if (omitted) {
      line.status = entry->status;
      line.reason = entry->reason;
      line.sabotage = true;
      line.omitted = true;
      emit(line);
      return;
    }
    line.status = "freed";
    emit(line);
    by_rid_.erase(rid);
    return;
  }
  // G5a: a mesh RID the log knows (every other free -- items, canvases, ... -- changes nothing
  // here, as before).
  MeshEntry *mesh = find_mesh(rid);
  if (mesh == nullptr) {
    return;
  }
  Line line = base_line(ctx, "free");
  line.rid = rid;
  line.kind = "mesh";
  line.id = mesh->id;
  line.version = mesh->version;
  if (omitted) {
    line.status = mesh->status;
    line.reason = mesh->reason;
    line.sabotage = true;
    line.omitted = true;
    emit(line);
    return;
  }
  line.status = "freed";
  emit(line);
  mesh_by_rid_.erase(rid);
}

void ResourceLog::spurious_update(const TapContext &ctx, std::uint64_t rid) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Entry *entry = find(rid);
  if (entry == nullptr) {
    return;
  }
  // The same bytes again at a new version (gate2-design.md G2b2 spurious-texture-update).
  entry->version += 1;
  Line line = base_line(ctx, "texture_2d_update");
  line.id = entry->id;
  line.rid = rid;
  line.version = entry->version;
  line.kind = entry->kind;
  line.status = entry->status;
  line.reason = entry->reason;
  line.payload = &entry->payload;
  line.has_layer = true;
  line.layer = 0;
  line.sabotage = true;
  emit(line);
}

void ResourceLog::resource_event(const TapContext &ctx, const char *op, const std::string &hash,
                                 std::uint64_t payload_bytes, const char *status,
                                 std::uint64_t conn) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  PayloadCopy described;
  described.payload_bytes = static_cast<std::int64_t>(payload_bytes);
  described.hash = hash;
  Line line = base_line(ctx, op);
  line.status = status;
  line.payload = &described;
  line.conn = conn;
  emit(line);
}

void ResourceLog::serve_event(const TapContext &ctx, const char *op, const std::string &hash,
                              std::uint64_t payload_bytes, const char *reason, std::uint64_t conn,
                              std::int64_t http_status, bool sabotage) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  PayloadCopy described;
  described.payload_bytes = static_cast<std::int64_t>(payload_bytes);
  described.hash = hash;
  Line line = base_line(ctx, op);
  line.reason = reason != nullptr ? reason : "";
  line.payload = &described;
  line.conn = conn;
  line.http_status = http_status;
  line.sabotage = sabotage;
  emit(line);
}

// A canvas_texture_set_* call on RID(): the CanvasTexture of a headless host (see
// canvas_texture_create). Logged as the same typed refusal, with no id.
void ResourceLog::null_canvas_texture(Line *line) {
  line->rid = 0;
  line->kind = "canvas";
  line->status = "unsupported";
  line->reason = "canvas-texture-headless";
  emit(*line);
}

void ResourceLog::canvas_texture_create(const TapContext &ctx, std::uint64_t rid, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  if (omitted) {
    Line line = base_line(ctx, "canvas_texture_create");
    line.rid = rid;
    line.sabotage = true;
    line.omitted = true;
    emit(line);
    return;
  }
  if (rid == 0) {
    // A headless host: the dummy storage's canvas_texture_allocate() returns RID()
    // (servers/rendering/dummy/storage/texture_storage.h:54). No id is spent (the mirror spends
    // none either); the line is the hook-side typed refusal (canvas-texture-headless).
    Line line = base_line(ctx, "canvas_texture_create");
    line.rid = 0;
    line.kind = "canvas";
    line.status = "unsupported";
    line.reason = "canvas-texture-headless";
    emit(line);
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
                                             std::int32_t channel, std::uint64_t texture,
                                             bool omitted) {
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
  if (canvas_texture == 0 && !omitted) {
    null_canvas_texture(&line);
    return;
  }
  Entry *ct = find(canvas_texture);
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
    if (ct != nullptr) {
      line.id = ct->id;
      line.version = ct->version;
      line.kind = ct->kind;
      line.status = ct->status;
    }
    emit(line);
    return;
  }
  if (ct != nullptr) {
    auto it = ct->channels.find(channel);
    const std::uint64_t old = it == ct->channels.end() ? 0 : it->second;
    if (old != texture) {
      ct->channels[channel] = texture;
      ct->version += 1;
    }
    // A non-null normal (1) or specular (2) channel makes the entry unsupported
    // (canvas-texture-channel); clearing both back to null makes it ok again (gate2-design.md
    // G2d, mirrored from Mirror::canvas_texture_set_channel).
    const auto channel_set = [&](std::int32_t c) {
      const auto found = ct->channels.find(c);
      return found != ct->channels.end() && found->second != 0;
    };
    if (channel_set(1) || channel_set(2)) {
      ct->status = "unsupported";
      ct->reason = "canvas-texture-channel";
    } else {
      ct->status = "ok";
      ct->reason.clear();
    }
    line.id = ct->id;
    line.version = ct->version;
    line.kind = ct->kind;
    line.status = ct->status;
    line.reason = ct->reason;
  }
  emit(line);
}

void ResourceLog::canvas_texture_set_filter(const TapContext &ctx, std::uint64_t canvas_texture,
                                            std::int32_t filter, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_texture_set_texture_filter");
  line.rid = canvas_texture;
  line.has_value = true;
  line.value = filter;
  if (canvas_texture == 0 && !omitted) {
    null_canvas_texture(&line);
    return;
  }
  Entry *ct = find(canvas_texture);
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
    if (ct != nullptr) {
      line.id = ct->id;
      line.version = ct->version;
      line.kind = ct->kind;
      line.status = ct->status;
    }
    emit(line);
    return;
  }
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
                                            std::int32_t repeat, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_texture_set_texture_repeat");
  line.rid = canvas_texture;
  line.has_value = true;
  line.value = repeat;
  if (canvas_texture == 0 && !omitted) {
    null_canvas_texture(&line);
    return;
  }
  Entry *ct = find(canvas_texture);
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
    if (ct != nullptr) {
      line.id = ct->id;
      line.version = ct->version;
      line.kind = ct->kind;
      line.status = ct->status;
    }
    emit(line);
    return;
  }
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

// --- meshes (gate5-design.md Q3d, G5a) --------------------------------------

ResourceLog::MeshEntry *ResourceLog::find_mesh(std::uint64_t rid) {
  auto it = mesh_by_rid_.find(rid);
  return it == mesh_by_rid_.end() ? nullptr : &it->second;
}

void ResourceLog::recompute_mesh_status(MeshEntry *entry) {
  for (const MeshSurfaceCopy &s : entry->surfaces) {
    if (s.status != "ok") {
      entry->status = "unsupported";
      entry->reason = s.reason;
      return;
    }
  }
  entry->status = "ok";
  entry->reason.clear();
}

namespace {

ResourceLog::Line mesh_line(const TapContext &ctx, const char *op, std::uint64_t rid) {
  ResourceLog::Line line = base_line(ctx, op);
  line.rid = rid;
  line.kind = "mesh";
  return line;
}

}  // namespace

void ResourceLog::mesh_create(const TapContext &ctx, std::uint64_t rid, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  if (omitted) {
    Line line = mesh_line(ctx, "mesh_create", rid);
    line.sabotage = true;
    line.omitted = true;
    emit(line);
    return;
  }
  MeshEntry entry;
  entry.id = next_mesh_id_++;
  entry.version = 1;
  entry.status = "ok";
  mesh_by_rid_[rid] = entry;
  Line line = mesh_line(ctx, "mesh_create", rid);
  line.id = entry.id;
  line.version = entry.version;
  line.status = entry.status;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::mesh_create_from_surfaces(const TapContext &ctx, std::uint64_t rid,
                                            const std::vector<MeshSurfaceCopy> &surfaces,
                                            bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  if (omitted) {
    Line line = mesh_line(ctx, "mesh_create_from_surfaces", rid);
    line.sabotage = true;
    line.omitted = true;
    emit(line);
    return;
  }
  MeshEntry entry;
  entry.id = next_mesh_id_++;
  entry.version = 1;
  entry.surfaces = surfaces;
  recompute_mesh_status(&entry);
  mesh_by_rid_[rid] = entry;
  Line line = mesh_line(ctx, "mesh_create_from_surfaces", rid);
  line.id = entry.id;
  line.version = entry.version;
  line.status = entry.status;
  line.reason = entry.reason;
  line.outcome = "applied";
  // G5c (gate5-design.md "As built (G5c)"): a creation with exactly one surface -- every loaded
  // single-surface ArrayMesh -- carries that surface on its line, exactly as a mesh_add_surface
  // line would (surface 0, hash, format, counts, copy/hash cost), so the log alone names every
  // surface hash. With several surfaces the line keeps them all null, as before.
  if (surfaces.size() == 1) {
    line.mesh_payload = &surfaces[0];
    line.has_surface = true;
    line.surface = 0;
  }
  emit(line);
}

void ResourceLog::mesh_add_surface(const TapContext &ctx, std::uint64_t rid,
                                   const MeshSurfaceCopy &surface, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = mesh_line(ctx, "mesh_add_surface", rid);
  line.mesh_payload = &surface;
  MeshEntry *entry = find_mesh(rid);
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
    if (entry != nullptr) {
      line.id = entry->id;
      line.version = entry->version;
      line.status = entry->status;
      line.reason = entry->reason;
    }
    emit(line);
    return;
  }
  if (entry == nullptr) {
    line.outcome = "unknown";
    emit(line);
    return;
  }
  line.has_surface = true;
  line.surface = static_cast<std::int32_t>(entry->surfaces.size());
  entry->surfaces.push_back(surface);
  entry->version += 1;
  recompute_mesh_status(entry);
  line.id = entry->id;
  line.version = entry->version;
  line.status = entry->status;
  line.reason = entry->reason;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::mesh_surface_update_region(const TapContext &ctx, std::uint64_t rid,
                                             const char *buffer, std::int32_t surface,
                                             std::int32_t offset, std::int64_t bytes,
                                             const char *outcome,
                                             const MeshSurfaceCopy *new_surface, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  const std::string op = std::string("mesh_surface_update_") + buffer + "_region";
  Line line = mesh_line(ctx, op.c_str(), rid);
  line.buffer = buffer;
  line.has_surface = true;
  line.surface = surface;
  line.has_offset = true;
  line.offset = offset;
  line.has_bytes = true;
  line.bytes = bytes;
  line.outcome = outcome;
  line.mesh_payload = new_surface;
  MeshEntry *entry = find_mesh(rid);
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
    if (entry != nullptr) {
      line.id = entry->id;
      line.version = entry->version;
      line.status = entry->status;
      line.reason = entry->reason;
    }
    emit(line);
    return;
  }
  if (entry == nullptr) {
    emit(line);
    return;
  }
  line.id = entry->id;
  if (std::string(outcome) == "applied") {
    // An update on an already-unsupported surface still bumps the version with no hash change
    // (gate5-design.md Q3b: "on an unsupported entry: version + 1 only"); `new_surface` is then
    // null (the caller never re-hashes a surface it never decoded).
    entry->version += 1;
    if (new_surface != nullptr && surface >= 0 &&
        static_cast<std::size_t>(surface) < entry->surfaces.size()) {
      entry->surfaces[static_cast<std::size_t>(surface)] = *new_surface;
    }
    recompute_mesh_status(entry);
  }
  line.version = entry->version;
  line.status = entry->status;
  line.reason = entry->reason;
  emit(line);
}

void ResourceLog::mesh_surface_remove(const TapContext &ctx, std::uint64_t rid,
                                      std::int32_t surface, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = mesh_line(ctx, "mesh_surface_remove", rid);
  line.has_surface = true;
  line.surface = surface;
  MeshEntry *entry = find_mesh(rid);
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
    if (entry != nullptr) {
      line.id = entry->id;
      line.version = entry->version;
      line.status = entry->status;
      line.reason = entry->reason;
    }
    emit(line);
    return;
  }
  if (entry == nullptr || surface < 0 ||
      static_cast<std::size_t>(surface) >= entry->surfaces.size()) {
    line.outcome = "unknown";
    if (entry != nullptr) {
      line.id = entry->id;
      line.version = entry->version;
      line.status = entry->status;
      line.reason = entry->reason;
    }
    emit(line);
    return;
  }
  entry->surfaces.erase(entry->surfaces.begin() + surface);
  entry->version += 1;
  recompute_mesh_status(entry);
  line.id = entry->id;
  line.version = entry->version;
  line.status = entry->status;
  line.reason = entry->reason;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::mesh_clear(const TapContext &ctx, std::uint64_t rid, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = mesh_line(ctx, "mesh_clear", rid);
  MeshEntry *entry = find_mesh(rid);
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
    if (entry != nullptr) {
      line.id = entry->id;
      line.version = entry->version;
      line.status = entry->status;
      line.reason = entry->reason;
    }
    emit(line);
    return;
  }
  if (entry == nullptr) {
    line.outcome = "unknown";
    emit(line);
    return;
  }
  entry->surfaces.clear();
  entry->status = "ok";
  entry->reason.clear();
  entry->version += 1;
  line.id = entry->id;
  line.version = entry->version;
  line.status = entry->status;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::mesh_set_custom_aabb(const TapContext &ctx, std::uint64_t rid, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = mesh_line(ctx, "mesh_set_custom_aabb", rid);
  MeshEntry *entry = find_mesh(rid);
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
    if (entry != nullptr) {
      line.id = entry->id;
      line.version = entry->version;
      line.status = entry->status;
      line.reason = entry->reason;
    }
    emit(line);
    return;
  }
  if (entry == nullptr) {
    line.outcome = "unknown";
    emit(line);
    return;
  }
  entry->version += 1;
  line.id = entry->id;
  line.version = entry->version;
  line.status = entry->status;
  line.reason = entry->reason;
  line.outcome = "applied";
  emit(line);
}

std::uint64_t ResourceLog::texture_id(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = by_rid_.find(rid);
  return it == by_rid_.end() ? 0 : it->second.id;
}

std::uint64_t ResourceLog::mesh_id(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = mesh_by_rid_.find(rid);
  return it == mesh_by_rid_.end() ? 0 : it->second.id;
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
