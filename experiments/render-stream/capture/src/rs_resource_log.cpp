#include "rs_resource_log.h"

#include "rs_texture_worker.h"

#include <cstdio>

#include "rs_mesh_payload.h"
#include "rs_sha256.h"
#include "rs_texture_payload.h"

namespace grc {
namespace rs {

namespace {

// 9 significant digits round-trips an IEEE-754 float32 exactly (report.cpp's JsonWriter::
// field(float) uses the same format), which is all this log needs: a reader that parses the
// JSON number back gets the identical float32 value.
void append_float(std::string *out, float value) {
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%.9g", static_cast<double>(value));
  *out += buf;
}

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
  std::string coding;  // G8kz: a 200 http-get line's content coding (trailing keys), "" otherwise
  std::uint64_t coded_bytes = 0;
  std::string method;  // G7n: "OPTIONS" on a preflight's http-get line only (trailing key)
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
  // G55a (gate5_5-design.md Q3d): shader/material/item-material trailing columns. `hash`/
  // `payload_bytes`/`copy_ns`/`hash_ns` share the texture/mesh columns above through this
  // pointer, as a mesh line shares them through `mesh_payload`.
  const ShaderCopy *shader_copy = nullptr;
  std::string param;       // the decoded StringName, present on a material/item-material line
  std::string param_type;  // rs::DecodedParam::type
  bool has_n = false;
  std::int64_t n = 0;
  bool has_decode_ns = false;
  std::int64_t decode_ns = 0;
  // G6k (gate6-design.md Q2): canvas trailing columns, null on every other line.
  bool has_sublayer = false;
  std::int32_t sublayer = 0;
  bool has_transform = false;
  float transform[6] = {};
  std::uint64_t parent = 0;  // 0 = null
  bool has_parent = false;
  bool has_mirroring = false;
  float mirroring[2] = {};
  bool has_repeat = false;
  float repeat_size[2] = {};
  std::int32_t repeat_times = 0;
  // G8r: trailing keys of an adopt line only ("" elsewhere).
  std::string adopted_content;
  std::string adopt_source;
};

// G8kw: a line held for a texture worker's hash (`job` set; `payload` is the line's own copy,
// filled when the job finishes), or plain text logged behind such a line (`job` null).
struct ResourceLog::Deferred {
  Line line;
  PayloadCopy payload;
  std::shared_ptr<TextureJob> job;
  std::string text;
};

void ResourceLog::settle(Entry *entry) {
  if (entry->job == nullptr || !entry->job->done() || entry->job->mispredict()) {
    return;
  }
  entry->job->fill(&entry->payload);
  entry->job.reset();
}

void ResourceLog::emit(const Line &l, const std::shared_ptr<TextureJob> &job) {
  const bool waits = job != nullptr && !job->done() && l.payload != nullptr;
  if (!waits && deferred_.empty()) {
    if (job != nullptr && l.payload != nullptr) {
      PayloadCopy filled = *l.payload;
      job->fill(&filled);
      Line copy = l;
      copy.payload = &filled;
      format(&pending_, copy);
      return;
    }
    format(&pending_, l);
    return;
  }
  if (waits) {
    auto held = std::make_shared<Deferred>();
    held->line = l;
    held->payload = *l.payload;
    held->job = job;
    deferred_.push_back(std::move(held));
    return;
  }
  // Behind a held line: formatted now (its own values are final), released in order.
  if (deferred_.back()->job != nullptr) {
    deferred_.push_back(std::make_shared<Deferred>());
  }
  std::string &text = deferred_.back()->text;
  if (job != nullptr && l.payload != nullptr) {
    PayloadCopy filled = *l.payload;
    job->fill(&filled);
    Line copy = l;
    copy.payload = &filled;
    format(&text, copy);
  } else {
    format(&text, l);
  }
}

void ResourceLog::format(std::string *out, const Line &l) const {
  std::string &o = *out;
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
  const ShaderCopy *sp = l.shader_copy;
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
  i64_or_null(p != nullptr || sp != nullptr,
             p != nullptr ? p->payload_bytes : (sp != nullptr ? sp->payload_bytes : 0));
  key("hash");
  str_or_null(p != nullptr ? p->hash
                           : (mp != nullptr ? mp->hash : (sp != nullptr ? sp->hash : std::string())));
  key("copy_ns");
  if (p != nullptr) {
    i64_or_null(p->copy_ns >= 0, p->copy_ns);
  } else if (mp != nullptr) {
    i64_or_null(mp->copy_ns >= 0, mp->copy_ns);
  } else {
    i64_or_null(sp != nullptr && sp->copy_ns >= 0, sp != nullptr ? sp->copy_ns : 0);
  }
  key("hash_ns");
  if (p != nullptr) {
    i64_or_null(p->hash_ns >= 0, p->hash_ns);
  } else if (mp != nullptr) {
    i64_or_null(mp->hash_ns >= 0, mp->hash_ns);
  } else {
    i64_or_null(sp != nullptr && sp->hash_ns >= 0, sp != nullptr ? sp->hash_ns : 0);
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
  // G55a (gate5_5-design.md Q3d): shader/material/item-material trailing columns, null on every
  // other line.
  key("mode");
  str_or_null(sp != nullptr ? sp->mode : std::string());
  key("source");
  str_or_null(sp != nullptr && !sp->hash.empty() ? std::string("payload") : std::string());
  key("builtin");
  if (sp != nullptr && sp->builtin) {
    o += "{\"kind\":\"canvas_item_material\",\"blend_mode\":";
    append_string(&o, sp->builtin_blend_mode);
    o += ",\"light_mode\":";
    append_string(&o, sp->builtin_light_mode);
    o += ",\"particles_animation\":";
    o += sp->builtin_particles_animation ? "true" : "false";
    o += "}";
  } else {
    o += "null";
  }
  key("uses");
  if (sp != nullptr) {
    o += "[";
    for (std::size_t i = 0; i < sp->uses.size(); ++i) {
      if (i != 0) {
        o += ",";
      }
      append_string(&o, sp->uses[i]);
    }
    o += "]";
  } else {
    o += "null";
  }
  key("scan_ns");
  i64_or_null(sp != nullptr && sp->scan_ns >= 0, sp != nullptr ? sp->scan_ns : 0);
  key("param");
  str_or_null(l.param);
  key("type");
  str_or_null(l.param_type);
  key("n");
  i64_or_null(l.has_n, l.n);
  key("decode_ns");
  if (p != nullptr) {
    // G8t: a texture line's host-decode time (null unless a decode was tried).
    i64_or_null(p->decode_ns >= 0, p->decode_ns);
  } else {
    i64_or_null(l.has_decode_ns, l.decode_ns);
  }
  // G6k (gate6-design.md Q2): canvas trailing columns, null on every other line.
  key("sublayer");
  i64_or_null(l.has_sublayer, l.sublayer);
  key("transform");
  if (l.has_transform) {
    o += "[";
    for (int i = 0; i < 6; ++i) {
      if (i != 0) {
        o += ",";
      }
      append_float(&o, l.transform[i]);
    }
    o += "]";
  } else {
    o += "null";
  }
  key("parent");
  if (l.has_parent) {
    append_string(&o, std::to_string(l.parent));
  } else {
    o += "null";
  }
  key("mirroring");
  if (l.has_mirroring) {
    o += "[";
    append_float(&o, l.mirroring[0]);
    o += ",";
    append_float(&o, l.mirroring[1]);
    o += "]";
  } else {
    o += "null";
  }
  key("repeat");
  if (l.has_repeat) {
    o += "[";
    append_float(&o, l.repeat_size[0]);
    o += ",";
    append_float(&o, l.repeat_size[1]);
    o += ",";
    o += std::to_string(l.repeat_times);
    o += "]";
  } else {
    o += "null";
  }
  // G8t (gate8-design.md D8): present only on a host-decoded texture's line, the format the
  // payload was decoded from (`format` is the payload's).
  if (p != nullptr && p->source_format >= 0) {
    o += ",\"source_format\":";
    const char *source = image_format_name(p->source_format);
    append_string(&o, source != nullptr ? source : "");
  }
  // G8kw (rs_texture_worker.h): present only on a line whose copy a texture worker made.
  if (p != nullptr && p->worker) {
    o += ",\"worker\":true,\"hook_ns\":";
    o += std::to_string(p->hook_ns);
    o += ",\"dup_ns\":";
    o += std::to_string(p->dup_ns);
  }
  // G8r: present only on an adopt line.
  if (!l.adopted_content.empty()) {
    o += ",\"adopted_content\":";
    append_string(&o, l.adopted_content);
    o += ",\"adopt_source\":";
    append_string(&o, l.adopt_source);
  }
  // G2b2: present only on a sabotage's own lines (spurious-texture-update's version bump; an
  // op the omit-op sabotage left out of the registry, `omitted`).
  if (l.sabotage) {
    o += ",\"sabotage\":true";
  }
  if (l.omitted) {
    o += ",\"omitted\":true";
  }
  if (!l.method.empty()) {
    o += ",\"method\":";
    append_string(&o, l.method);
  }
  if (!l.coding.empty()) {
    o += ",\"coding\":";
    append_string(&o, l.coding);
    o += ",\"coded_bytes\":" + std::to_string(l.coded_bytes);
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
  next_shader_id_ = 1;
  shader_by_rid_.clear();
  next_material_id_ = 1;
  material_by_rid_.clear();
  pending_.clear();
  deferred_.clear();
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
                                    const PayloadCopy &copy, bool omitted,
                                    std::shared_ptr<TextureJob> job) {
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
    emit(line, job);
    return;
  }
  Entry entry;
  entry.id = next_id_++;
  entry.kind = "image";
  entry.version = 1;
  entry.status = copy.status;
  entry.reason = copy.reason;
  entry.payload = copy;
  entry.job = job;
  by_rid_[rid] = entry;
  Line line = base_line(ctx, "texture_2d_create");
  line.id = entry.id;
  line.rid = rid;
  line.version = entry.version;
  line.kind = entry.kind;
  line.status = entry.status;
  line.reason = entry.reason;
  line.payload = &copy;
  emit(line, job);
}

void ResourceLog::texture_adopt(const TapContext &ctx, std::uint64_t rid, const PayloadCopy &copy,
                                const char *content, const char *source,
                                std::shared_ptr<TextureJob> job) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_ || rid == 0 || by_rid_.count(rid) != 0) {
    return;
  }
  Entry entry;
  entry.id = next_id_++;
  entry.kind = "image";
  entry.version = 1;
  entry.status = copy.status;
  entry.reason = copy.reason;
  entry.payload = copy;
  entry.job = job;
  by_rid_[rid] = entry;
  Line line = base_line(ctx, "adopt");
  line.id = entry.id;
  line.rid = rid;
  line.version = entry.version;
  line.kind = entry.kind;
  line.status = entry.status;
  line.reason = entry.reason;
  line.payload = &copy;
  line.adopted_content = content;
  line.adopt_source = source;
  emit(line, job);
}

void ResourceLog::texture_2d_update(const TapContext &ctx, std::uint64_t rid,
                                    const PayloadCopy &copy, int layer, bool omitted,
                                    std::shared_ptr<TextureJob> job) {
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
    emit(line, job);
    return;
  }
  if (entry == nullptr) {
    // An update to a texture the capture never saw created changes nothing the
    // stream shows (Q3); it is counted and logged with a null id.
    ++update_unknown_;
    line.reason = "unknown-texture";
    emit(line, job);
    return;
  }
  entry->version += 1;
  entry->job.reset();  // G8kw: superseded (the shape below is the hook's, known either way)
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
    entry->job = job;
  }
  line.id = entry->id;
  line.version = entry->version;
  line.kind = entry->kind;
  line.status = entry->status;
  line.reason = entry->reason;
  emit(line, job);
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
  std::shared_ptr<TextureJob> replaced_job;  // G8kw: b's pending payload, now t's
  if (t != nullptr) {
    t->version += 1;
    if (b != nullptr) {
      settle(b);
      t->kind = b->kind;
      t->status = b->status;
      t->reason = b->reason;
      t->payload = b->payload;
      t->job = b->job;  // G8kw: still pending: the line below waits for it
      t->filter = b->filter;
      t->repeat = b->repeat;
      t->channels = b->channels;
      line.payload = &t->payload;
      replaced_job = t->job;
    } else {
      t->status = "unsupported";
      t->reason = "unknown-texture";
      t->job.reset();
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
  emit(line, replaced_job);
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
  if (mesh != nullptr) {
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
    return;
  }
  // G55a: a shader or material RID the log knows.
  ShaderEntry *shader = find_shader(rid);
  if (shader != nullptr) {
    ShaderCopy snapshot;
    snapshot.status = shader->status;
    snapshot.reason = shader->reason;
    snapshot.mode = shader->mode;
    snapshot.uses = shader->uses;
    snapshot.builtin = shader->builtin;
    snapshot.builtin_blend_mode = shader->builtin_blend_mode;
    snapshot.builtin_light_mode = shader->builtin_light_mode;
    snapshot.builtin_particles_animation = shader->builtin_particles_animation;
    snapshot.hash = shader->hash;
    snapshot.payload_bytes = shader->payload_bytes;
    Line line = base_line(ctx, "free");
    line.rid = rid;
    line.kind = "shader";
    line.id = shader->id;
    line.version = shader->version;
    line.shader_copy = &snapshot;
    if (omitted) {
      line.status = shader->status;
      line.reason = shader->reason;
      line.sabotage = true;
      line.omitted = true;
      emit(line);
      return;
    }
    line.status = "freed";
    emit(line);
    shader_by_rid_.erase(rid);
    // G55d (gate5_5-design.md D5; g3ms.cpp:2184-2198): freeing a shader sets every material that
    // names it to no shader, version + 1 -- the mirror's rule, applied here too so both registries
    // keep counting the same versions. No line of its own: a reader replays it from this free
    // line (every material whose last shader was this one).
    for (auto &entry : material_by_rid_) {
      MaterialEntry &material_entry = entry.second;
      if (material_entry.shader_rid == rid) {
        material_entry.shader_rid = 0;
        material_entry.version += 1;
        recompute_material_status(&material_entry);
      }
    }
    return;
  }
  MaterialEntry *material = find_material(rid);
  if (material != nullptr) {
    Line line = base_line(ctx, "free");
    line.rid = rid;
    line.kind = "material";
    line.id = material->id;
    line.version = material->version;
    if (omitted) {
      line.status = material->status;
      line.reason = material->reason;
      line.sabotage = true;
      line.omitted = true;
      emit(line);
      return;
    }
    line.status = "freed";
    emit(line);
    material_by_rid_.erase(rid);
    return;
  }
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
  settle(entry);
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
  emit(line, entry->job);
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
                              std::int64_t http_status, bool sabotage, const char *method,
                              const char *coding, std::uint64_t coded_bytes) {
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
  line.method = method != nullptr ? method : "";
  line.coding = coding != nullptr ? coding : "";
  line.coded_bytes = coded_bytes;
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

void ResourceLog::mesh_adopt(const TapContext &ctx, std::uint64_t rid,
                             const std::vector<MeshSurfaceCopy> &surfaces) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_ || rid == 0 || mesh_by_rid_.count(rid) != 0) {
    return;
  }
  MeshEntry entry;
  entry.id = next_mesh_id_++;
  entry.version = 1;
  entry.surfaces = surfaces;
  recompute_mesh_status(&entry);
  mesh_by_rid_[rid] = entry;
  Line line = mesh_line(ctx, "adopt", rid);
  line.id = entry.id;
  line.version = entry.version;
  line.status = entry.status;
  line.reason = entry.reason;
  line.outcome = "applied";
  if (surfaces.size() == 1) {
    line.mesh_payload = &surfaces[0];
    line.has_surface = true;
    line.surface = 0;
  }
  line.adopted_content = "creation";
  line.adopt_source = "dummy";
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

// --- shaders and materials (gate5_5-design.md Q3d, G55a) --------------------

ResourceLog::ShaderEntry *ResourceLog::find_shader(std::uint64_t rid) {
  auto it = shader_by_rid_.find(rid);
  return it == shader_by_rid_.end() ? nullptr : &it->second;
}

ResourceLog::MaterialEntry *ResourceLog::find_material(std::uint64_t rid) {
  auto it = material_by_rid_.find(rid);
  return it == material_by_rid_.end() ? nullptr : &it->second;
}

void ResourceLog::recompute_material_status(MaterialEntry *entry) {
  if (entry->shader_rid != 0 && find_shader(entry->shader_rid) == nullptr) {
    entry->status = "unsupported";
    entry->reason = "unknown-shader";
  } else {
    entry->status = "ok";
    entry->reason.clear();
  }
}

void ResourceLog::copy_shader_fields(ShaderEntry *entry, const ShaderCopy &copy) {
  entry->status = copy.status;
  entry->reason = copy.reason;
  entry->mode = copy.mode;
  entry->uses = copy.uses;
  entry->builtin = copy.builtin;
  entry->builtin_blend_mode = copy.builtin_blend_mode;
  entry->builtin_light_mode = copy.builtin_light_mode;
  entry->builtin_particles_animation = copy.builtin_particles_animation;
  entry->hash = copy.hash;
  entry->payload_bytes = copy.payload_bytes;
}

void ResourceLog::shader_create(const TapContext &ctx, std::uint64_t rid, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  if (omitted) {
    Line line = base_line(ctx, "shader_create");
    line.rid = rid;
    line.kind = "shader";
    line.sabotage = true;
    line.omitted = true;
    emit(line);
    return;
  }
  ShaderEntry entry;
  entry.id = next_shader_id_++;
  shader_by_rid_[rid] = entry;
  Line line = base_line(ctx, "shader_create");
  line.rid = rid;
  line.kind = "shader";
  line.id = entry.id;
  line.version = entry.version;
  line.status = entry.status;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::shader_create_from_code(const TapContext &ctx, std::uint64_t rid,
                                          const ShaderCopy &copy, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  if (omitted) {
    Line line = base_line(ctx, "shader_create_from_code");
    line.rid = rid;
    line.kind = "shader";
    line.shader_copy = &copy;
    line.sabotage = true;
    line.omitted = true;
    emit(line);
    return;
  }
  ShaderEntry entry;
  entry.id = next_shader_id_++;
  copy_shader_fields(&entry, copy);
  shader_by_rid_[rid] = entry;
  Line line = base_line(ctx, "shader_create_from_code");
  line.rid = rid;
  line.kind = "shader";
  line.id = entry.id;
  line.version = entry.version;
  line.status = entry.status;
  line.reason = entry.reason;
  line.shader_copy = &copy;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::shader_set_code(const TapContext &ctx, std::uint64_t rid, const ShaderCopy &copy,
                                  bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "shader_set_code");
  line.rid = rid;
  line.kind = "shader";
  line.shader_copy = &copy;
  ShaderEntry *entry = find_shader(rid);
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
  copy_shader_fields(entry, copy);
  line.id = entry->id;
  line.version = entry->version;
  line.status = entry->status;
  line.reason = entry->reason;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::shader_set_default_texture_parameter(const TapContext &ctx, std::uint64_t shader,
                                                        const std::string &name,
                                                        std::uint64_t texture, std::int32_t index,
                                                        bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "shader_set_default_texture_parameter");
  line.rid = shader;
  line.kind = "shader";
  line.param = name;
  line.has_target = true;
  line.target = texture;
  if (const Entry *tex = find(texture)) {
    line.ref_id = tex->id;
  }
  line.has_value = true;
  line.value = index;
  ShaderEntry *entry = find_shader(shader);
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

void ResourceLog::material_create(const TapContext &ctx, std::uint64_t rid, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  if (omitted) {
    Line line = base_line(ctx, "material_create");
    line.rid = rid;
    line.kind = "material";
    line.sabotage = true;
    line.omitted = true;
    emit(line);
    return;
  }
  MaterialEntry entry;
  entry.id = next_material_id_++;
  material_by_rid_[rid] = entry;
  Line line = base_line(ctx, "material_create");
  line.rid = rid;
  line.kind = "material";
  line.id = entry.id;
  line.version = entry.version;
  line.status = entry.status;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::material_create_from_shader(const TapContext &ctx, std::uint64_t rid,
                                              std::uint64_t shader, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "material_create_from_shader");
  line.rid = rid;
  line.kind = "material";
  if (shader != 0) {
    line.has_target = true;
    line.target = shader;
  }
  if (const ShaderEntry *s = find_shader(shader)) {
    line.ref_id = s->id;
  }
  if (omitted) {
    line.sabotage = true;
    line.omitted = true;
    emit(line);
    return;
  }
  MaterialEntry entry;
  entry.id = next_material_id_++;
  entry.shader_rid = shader;
  recompute_material_status(&entry);
  material_by_rid_[rid] = entry;
  line.id = entry.id;
  line.version = entry.version;
  line.status = entry.status;
  line.reason = entry.reason;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::material_set_shader(const TapContext &ctx, std::uint64_t material,
                                      std::uint64_t shader, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "material_set_shader");
  line.rid = material;
  line.kind = "material";
  if (shader != 0) {
    line.has_target = true;
    line.target = shader;
  }
  if (const ShaderEntry *s = find_shader(shader)) {
    line.ref_id = s->id;
  }
  MaterialEntry *entry = find_material(material);
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
  entry->shader_rid = shader;
  entry->version += 1;
  recompute_material_status(entry);
  line.id = entry->id;
  line.version = entry->version;
  line.status = entry->status;
  line.reason = entry->reason;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::material_set_param(const TapContext &ctx, std::uint64_t material,
                                     const std::string &name, const MaterialParamCopy &copy,
                                     bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "material_set_param");
  line.rid = material;
  line.kind = "material";
  line.param = name;
  line.param_type = copy.type;
  line.has_n = true;
  line.n = copy.n;
  line.has_decode_ns = true;
  line.decode_ns = copy.decode_ns;
  line.outcome = copy.outcome;
  MaterialEntry *entry = find_material(material);
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
  // D6: an OBJECT value is rejected outright (no change); every other outcome, including an
  // erasing NIL and an unsupported-type value that is still stored, bumps the version.
  if (copy.outcome != "rejected") {
    entry->version += 1;
  }
  line.id = entry->id;
  line.version = entry->version;
  line.status = entry->status;
  line.reason = entry->reason;
  emit(line);
}

void ResourceLog::canvas_item_set_material(const TapContext &ctx, std::uint64_t item,
                                           std::uint64_t material) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_item_set_material");
  line.rid = item;
  line.kind = "item-material";
  if (material != 0) {
    line.has_target = true;
    line.target = material;
  }
  if (const MaterialEntry *m = find_material(material)) {
    line.ref_id = m->id;
  }
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::canvas_item_set_use_parent_material(const TapContext &ctx, std::uint64_t item,
                                                      bool enable) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_item_set_use_parent_material");
  line.rid = item;
  line.kind = "item-material";
  line.has_value = true;
  line.value = enable ? 1 : 0;
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::canvas_item_set_instance_shader_parameter(const TapContext &ctx,
                                                             std::uint64_t item,
                                                             const std::string &name,
                                                             const MaterialParamCopy &copy) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_item_set_instance_shader_parameter");
  line.rid = item;
  line.kind = "item-material";
  line.param = name;
  line.param_type = copy.type;
  line.has_n = true;
  line.n = copy.n;
  line.has_decode_ns = true;
  line.decode_ns = copy.decode_ns;
  line.outcome = copy.outcome;
  emit(line);
}

void ResourceLog::canvas_set_modulate(const TapContext &ctx, std::uint64_t canvas) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_set_modulate");
  line.rid = canvas;
  line.kind = "item-material";
  line.outcome = "applied";
  emit(line);
}

void ResourceLog::canvas_light_attach_to_canvas(const TapContext &ctx, std::uint64_t light,
                                                std::uint64_t canvas) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_light_attach_to_canvas");
  line.rid = light;
  line.kind = "item-material";
  // D10/D16: a non-null canvas is the typed, sticky session-level refusal; this hook log only
  // notes it per call (the sticky, once-ever session entry is G55d's mirror work).
  if (canvas != 0) {
    line.has_target = true;
    line.target = canvas;
    line.status = "unsupported";
    line.reason = "canvas-light";
  }
  emit(line);
}

// --- canvases (gate6-design.md Q2, G6k, calibrator 9): decode and log only, no registry, no
// classification (that is G6b's mirror). See the header comment for the field layout. ---------

void ResourceLog::viewport_remove_canvas(const TapContext &ctx, std::uint64_t viewport,
                                         std::uint64_t canvas) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "viewport_remove_canvas");
  line.rid = canvas;
  line.kind = "canvas";
  if (viewport != 0) {
    line.has_target = true;
    line.target = viewport;
  }
  emit(line);
}

void ResourceLog::viewport_set_global_canvas_transform(const TapContext &ctx,
                                                        std::uint64_t viewport,
                                                        const float *transform) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "viewport_set_global_canvas_transform");
  line.rid = viewport;  // no canvas argument on this call
  line.kind = "canvas";
  if (transform != nullptr) {
    line.has_transform = true;
    for (int i = 0; i < 6; ++i) {
      line.transform[i] = transform[i];
    }
  }
  emit(line);
}

void ResourceLog::viewport_set_canvas_stacking(const TapContext &ctx, std::uint64_t viewport,
                                               std::uint64_t canvas, std::int32_t layer,
                                               std::int32_t sublayer) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "viewport_set_canvas_stacking");
  line.rid = canvas;
  line.kind = "canvas";
  if (viewport != 0) {
    line.has_target = true;
    line.target = viewport;
  }
  line.has_layer = true;
  line.layer = layer;
  line.has_sublayer = true;
  line.sublayer = sublayer;
  emit(line);
}

void ResourceLog::canvas_set_item_mirroring(const TapContext &ctx, std::uint64_t canvas,
                                            std::uint64_t item, const float *mirroring) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_set_item_mirroring");
  line.rid = canvas;
  line.kind = "canvas";
  if (item != 0) {
    line.has_target = true;
    line.target = item;
  }
  if (mirroring != nullptr) {
    line.has_mirroring = true;
    line.mirroring[0] = mirroring[0];
    line.mirroring[1] = mirroring[1];
  }
  emit(line);
}

void ResourceLog::canvas_set_item_repeat(const TapContext &ctx, std::uint64_t item,
                                         const float *repeat_size, std::int32_t repeat_times) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_set_item_repeat");
  line.rid = item;  // the call's only RID argument
  line.kind = "canvas";
  if (repeat_size != nullptr) {
    line.has_repeat = true;
    line.repeat_size[0] = repeat_size[0];
    line.repeat_size[1] = repeat_size[1];
    line.repeat_times = repeat_times;
  }
  emit(line);
}

void ResourceLog::canvas_set_parent(const TapContext &ctx, std::uint64_t canvas,
                                    std::uint64_t parent) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  Line line = base_line(ctx, "canvas_set_parent");
  line.rid = canvas;
  line.kind = "canvas";
  if (parent != 0) {
    line.has_parent = true;
    line.parent = parent;
  }
  emit(line);
}

// --- PM1: multimesh lines (rule 12) -----------------------------------------------------------

namespace {

void append_key(std::string *out, const char *key) {
  out->push_back(',');
  out->push_back('"');
  *out += key;
  *out += "\":";
}

void append_rid(std::string *out, std::uint64_t rid) {
  if (rid == 0) {
    *out += "null";
  } else {
    append_string(out, std::to_string(rid));
  }
}

void append_id(std::string *out, std::uint64_t id) {
  if (id == 0) {
    *out += "null";
  } else {
    *out += std::to_string(id);
  }
}

}  // namespace

MultimeshArgs &MultimeshArgs::i64(const char *key, std::int64_t value) {
  append_key(&text_, key);
  text_ += std::to_string(value);
  return *this;
}

MultimeshArgs &MultimeshArgs::boolean(const char *key, bool value) {
  append_key(&text_, key);
  text_ += value ? "true" : "false";
  return *this;
}

MultimeshArgs &MultimeshArgs::rid(const char *key, std::uint64_t value) {
  append_key(&text_, key);
  append_rid(&text_, value);
  return *this;
}

MultimeshArgs &MultimeshArgs::id(const char *key, std::uint64_t value) {
  append_key(&text_, key);
  append_id(&text_, value);
  return *this;
}

MultimeshArgs &MultimeshArgs::floats(const char *key, const float *values, std::size_t n) {
  append_key(&text_, key);
  text_.push_back('[');
  for (std::size_t i = 0; i < n; ++i) {
    if (i != 0) {
      text_.push_back(',');
    }
    const float v = values[i];
    if (v != v || v - v != 0.0f) {
      text_ += "null";  // NaN or infinite: JSON has no spelling for it
    } else {
      append_float(&text_, v);
    }
  }
  text_.push_back(']');
  return *this;
}

MultimeshArgs &MultimeshArgs::buffer(const char *key, const char *sha_key, const float *data,
                                     std::size_t count) {
  append_key(&text_, key);
  text_ += std::to_string(count);
  append_key(&text_, sha_key);
  append_string(&text_, sha256_hex(count == 0 ? static_cast<const void *>("") : data,
                                   count * sizeof(float)));  // the host is little-endian (abi.h)
  return *this;
}

void ResourceLog::emit_text(const std::string &text) {
  if (deferred_.empty()) {
    pending_ += text;
    return;
  }
  // Behind a held texture line: released in order (emit()'s rule for plain lines).
  if (deferred_.back()->job != nullptr) {
    deferred_.push_back(std::make_shared<Deferred>());
  }
  deferred_.back()->text += text;
}

void ResourceLog::multimesh_call(const TapContext &ctx, const char *call, std::uint64_t rid,
                                 std::uint64_t id, bool accepted, std::uint64_t version,
                                 const MultimeshArgs &args, bool omitted) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  std::string o = "{\"frame\":" + std::to_string(ctx.frame);
  append_key(&o, "t_us");
  o += std::to_string(ctx.t_ns >= t0_ns_ ? (ctx.t_ns - t0_ns_) / 1000 : 0);
  append_key(&o, "thread");
  append_string(&o, ctx.main_thread ? "main" : "other");
  append_key(&o, "kind");
  o += "\"multimesh\"";
  append_key(&o, "call");
  append_string(&o, call);
  append_key(&o, "rid");
  append_rid(&o, rid);
  append_key(&o, "id");
  append_id(&o, id);
  append_key(&o, "accepted");
  o += accepted ? "true" : "false";
  append_key(&o, "version");
  append_id(&o, version);
  o += args.text();
  if (omitted) {
    o += ",\"omitted\":true";
  }
  o += "}\n";
  emit_text(o);
}

void ResourceLog::multimesh_state(const TapContext &ctx, const MultimeshState &state) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!active_) {
    return;
  }
  std::string o = "{\"frame\":" + std::to_string(state.frame);
  append_key(&o, "t_us");
  o += std::to_string(ctx.t_ns >= t0_ns_ ? (ctx.t_ns - t0_ns_) / 1000 : 0);
  append_key(&o, "thread");
  append_string(&o, ctx.main_thread ? "main" : "other");
  append_key(&o, "kind");
  o += "\"multimesh\"";
  append_key(&o, "call");
  o += "\"state\"";
  append_key(&o, "rid");
  append_rid(&o, state.rid);
  append_key(&o, "id");
  append_id(&o, state.id);
  append_key(&o, "version");
  o += std::to_string(state.version);
  append_key(&o, "instances");
  o += std::to_string(state.instances);
  append_key(&o, "format");
  append_string(&o, state.format);
  append_key(&o, "colors");
  o += state.colors ? "true" : "false";
  append_key(&o, "custom");
  o += state.custom ? "true" : "false";
  append_key(&o, "visible");
  o += std::to_string(state.visible);
  append_key(&o, "mesh");
  append_id(&o, state.mesh);
  append_key(&o, "status");
  append_string(&o, state.status);
  append_key(&o, "reason");
  if (state.reason == nullptr) {
    o += "null";
  } else {
    append_string(&o, state.reason);
  }
  append_key(&o, "buffer_sha256");
  if (std::string(state.status) == "ok" && state.buffer != nullptr) {
    const std::vector<float> &b = *state.buffer;
    append_string(&o, sha256_hex(b.empty() ? static_cast<const void *>("") : b.data(),
                                 b.size() * sizeof(float)));
  } else {
    o += "null";
  }
  o += "}\n";
  emit_text(o);
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

std::uint64_t ResourceLog::shader_id(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = shader_by_rid_.find(rid);
  return it == shader_by_rid_.end() ? 0 : it->second.id;
}

std::uint64_t ResourceLog::material_id(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = material_by_rid_.find(rid);
  return it == material_by_rid_.end() ? 0 : it->second.id;
}

std::string ResourceLog::take_lines() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::string out;
  out.swap(pending_);
  // G8kw: held lines leave in log order, each once its job delivered the hash.
  std::size_t taken = 0;
  for (; taken < deferred_.size(); ++taken) {
    Deferred &d = *deferred_[taken];
    if (d.job != nullptr) {
      if (!d.job->done()) {
        break;
      }
      d.job->fill(&d.payload);
      d.line.payload = &d.payload;
      format(&out, d.line);
    } else {
      out += d.text;
    }
  }
  deferred_.erase(deferred_.begin(), deferred_.begin() + static_cast<std::ptrdiff_t>(taken));
  return out;
}

std::size_t ResourceLog::deferred_lines() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return deferred_.size();
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
