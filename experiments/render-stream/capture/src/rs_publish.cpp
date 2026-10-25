#include "rs_publish.h"

#include <sys/random.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <utility>

#include "report.h"
#include "rs2_codec.h"
#include "rs2_diff.h"

namespace grc {
namespace rs2 {

namespace {

std::uint64_t saturating_add(std::uint64_t a, std::uint64_t b) {
  const std::uint64_t sum = a + b;  // a, b are each well under 2^53; no uint64 overflow risk
  return sum > kMaxJsonInteger ? kMaxJsonInteger : sum;
}

std::string dirname_of(const std::string &path) {
  const std::size_t slash = path.find_last_of('/');
  return slash == std::string::npos ? std::string() : path.substr(0, slash);
}

std::uint64_t monotonic_ns() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

void note_record_bytes(EndStats *stats, const std::vector<std::uint8_t> &bytes) {
  stats->bytes_total += bytes.size();
  stats->max_record_bytes =
      std::max(stats->max_record_bytes, static_cast<std::uint64_t>(bytes.size()));
}

bool is_op_name(const std::string &op) {
  return !op.empty() && std::all_of(op.begin(), op.end(), [](unsigned char c) {
    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_';
  });
}

bool is_ok_image(const TextureEntry &entry) {
  return entry.kind == TextureKind::Image && entry.status == TextureStatus::Ok && entry.has_hash;
}

}  // namespace

// ----------------------------------------------------------------- FileRecordSink

FileRecordSink::~FileRecordSink() { close(); }

bool FileRecordSink::open(const std::string &path) {
  close();
  const std::string dir = dirname_of(path);
  if (!dir.empty() && !make_directories(dir)) {
    return false;
  }
  file_ = std::fopen(path.c_str(), "wb");
  return file_ != nullptr;
}

bool FileRecordSink::write(const std::vector<std::uint8_t> &bytes) {
  if (file_ == nullptr) {
    return false;
  }
  if (bytes.empty()) {
    return true;
  }
  if (writer_ != nullptr) {
    // P3-CAP: queued in order behind the store payloads this record names (rs_file_writer.h).
    std::FILE *file = file_;
    return writer_->submit(
        [file, bytes](std::string *error) {
          if (std::fwrite(bytes.data(), 1, bytes.size(), file) != bytes.size()) {
            *error = "transaction write failed";
            return false;
          }
          return true;
        },
        bytes.size(), nullptr);
  }
  return std::fwrite(bytes.data(), 1, bytes.size(), file_) == bytes.size();
}

bool FileRecordSink::flush() {
  if (file_ == nullptr) {
    return false;
  }
  if (writer_ != nullptr) {
    std::FILE *file = file_;
    return writer_->submit(
        [file](std::string *error) {
          if (std::fflush(file) != 0) {
            *error = "transaction write failed";
            return false;
          }
          return true;
        },
        0, nullptr);
  }
  return std::fflush(file_) == 0;
}

void FileRecordSink::close() {
  if (writer_ != nullptr && file_ != nullptr) {
    writer_->drain();  // P3-CAP: every queued record first
  }
  if (file_ != nullptr) {
    std::fclose(file_);
    file_ = nullptr;
  }
}

// ----------------------------------------------------------------- MemoryRecordSink

bool MemoryRecordSink::open(const std::string &path) {
  opened_path = path;
  bytes.clear();
  writes.clear();
  flush_count = 0;
  is_open = true;
  was_closed = false;
  return true;
}

bool MemoryRecordSink::write(const std::vector<std::uint8_t> &data) {
  if (!is_open) {
    return false;
  }
  bytes.insert(bytes.end(), data.begin(), data.end());
  writes.push_back(data.size());
  return true;
}

bool MemoryRecordSink::flush() {
  if (!is_open) {
    return false;
  }
  ++flush_count;
  return true;
}

void MemoryRecordSink::close() {
  is_open = false;
  was_closed = true;
}

// ----------------------------------------------------------------- sabotage parsing

ParseResult parse_sabotage(const char *kind, const char *frame, const char *op) {
  ParseResult result;
  if (kind == nullptr) {
    result.config.kind = SabotageKind::None;
    return result;
  }
  const std::string kind_text(kind);
  static const std::pair<const char *, SabotageKind> kKinds[] = {
      {"freeze-frame", SabotageKind::FreezeFrame},
      {"omit-update", SabotageKind::OmitUpdate},
      {"perturb-transform", SabotageKind::PerturbTransform},
      {"omit-op", SabotageKind::OmitOp},
      {"patch-drop-item", SabotageKind::PatchDropItem},
      {"drop-message", SabotageKind::DropMessage},
      {"ignore-credit", SabotageKind::IgnoreCredit},
      {"stale-coalesce", SabotageKind::StaleCoalesce},
      {"stale-texture", SabotageKind::StaleTexture},
      {"wrong-hash", SabotageKind::WrongHash},
      {"spurious-texture-update", SabotageKind::SpuriousTextureUpdate},
      {"drop-resource", SabotageKind::DropResource},
      {"unpin", SabotageKind::Unpin},
      {"perturb-glyph", SabotageKind::PerturbGlyph},
      {"perturb-vertex", SabotageKind::PerturbVertex},
      {"perturb-shader", SabotageKind::PerturbShader},
      {"retain-superseded", SabotageKind::RetainSuperseded},
      // New at /8 (G8w, gate8-design.md Q2-Q5); declared on the wire here, acted on by G8a/G8t/
      // G8h/G8m (they need a /8 sink: rs_gate8_policy.h).
      {"adopt-skip-state", SabotageKind::AdoptSkipState},
      {"adopt-no-redraw", SabotageKind::AdoptNoRedraw},
      {"adopt-skip-layers", SabotageKind::AdoptSkipLayers},
      {"perturb-decode", SabotageKind::PerturbDecode},
      {"size-before-adopt", SabotageKind::SizeBeforeAdopt},
      {"adopt-raw-shader-code", SabotageKind::AdoptRawShaderCode},
      {"adopt-skip-params", SabotageKind::AdoptSkipParams},
  };
  bool known = false;
  for (const auto &entry : kKinds) {
    if (kind_text == entry.first) {
      result.config.kind = entry.second;
      known = true;
      break;
    }
  }
  if (!known) {
    result.ok = false;
    result.error = "unknown GRC_SABOTAGE kind \"" + kind_text + "\"";
    return result;
  }

  const std::string op_text = op != nullptr ? std::string(op) : std::string();
  if (result.config.kind == SabotageKind::OmitOp) {
    if (!is_op_name(op_text)) {
      result.ok = false;
      result.error = op_text.empty()
                         ? std::string("omit-op needs GRC_SABOTAGE_OP (a RenderingServer method name)")
                         : "GRC_SABOTAGE_OP \"" + op_text + "\" is not a method name ([a-z0-9_]+)";
      return result;
    }
    result.config.op = op_text;
  } else if (!op_text.empty()) {
    result.ok = false;
    result.error = "GRC_SABOTAGE_OP is only valid with omit-op (got kind " + kind_text + ")";
    return result;
  }

  if (frame == nullptr) {
    result.config.frame = 21;
    return result;
  }
  const std::string frame_text(frame);
  const bool all_digits =
      !frame_text.empty() && std::all_of(frame_text.begin(), frame_text.end(),
                                         [](unsigned char c) { return std::isdigit(c) != 0; });
  if (!all_digits) {
    result.ok = false;
    result.error = "GRC_SABOTAGE_FRAME \"" + frame_text + "\" is not a decimal integer";
    return result;
  }
  errno = 0;
  char *end = nullptr;
  const unsigned long long value = std::strtoull(frame_text.c_str(), &end, 10);
  if (errno != 0 || end == nullptr || *end != '\0' || value < 1) {
    result.ok = false;
    result.error = "GRC_SABOTAGE_FRAME \"" + frame_text + "\" must be an integer >= 1";
    return result;
  }
  result.config.frame = value;
  return result;
}

std::string generate_id() {
  unsigned char buf[16] = {};
  std::size_t got = 0;
  while (got < sizeof(buf)) {
    const ssize_t n = ::getrandom(buf + got, sizeof(buf) - got, 0);
    if (n < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;  // leaves the remaining bytes zero rather than looping forever
    }
    got += static_cast<std::size_t>(n);
  }
  static const char *const hex = "0123456789abcdef";
  std::string out;
  out.reserve(32);
  for (unsigned char b : buf) {
    out.push_back(hex[(b >> 4) & 0xF]);
    out.push_back(hex[b & 0xF]);
  }
  return out;
}

Features gate2_features(bool headless_host, ProtocolVersion version) {
  Features features;
  features.ops = {"add_rect", "add_texture_rect", "add_texture_rect_region"};
  if (version == ProtocolVersion::V3) {
    // render-stream-3.md "Features": sorted ascending by byte value.
    features.ops.insert(features.ops.begin(), "add_msdf_texture_rect_region");
  } else if (version == ProtocolVersion::V4 || version == ProtocolVersion::V5 ||
             version == ProtocolVersion::V6) {
    // render-stream-4.md "Features": /3's four plus the eleven /4 ops, sorted by byte value
    // (render-stream-5.md and render-stream-6.md "Features": unchanged at /5 and /6).
    features.ops = {"add_circle",         "add_clip_ignore",
                    "add_line",           "add_mesh",
                    "add_msdf_texture_rect_region",
                    "add_multiline",      "add_nine_patch",
                    "add_polygon",        "add_polyline",
                    "add_primitive",      "add_rect",
                    "add_set_transform",  "add_texture_rect",
                    "add_texture_rect_region",
                    "add_triangle_array"};
  }
  features.item_state = {"behind",         "children",         "clip",           "custom_rect",
                         "draw_index",     "modulate",         "parent",         "self_modulate",
                         "texture_filter", "texture_repeat",   "transform",      "visibility_layer",
                         "visible",        "z_index",          "z_relative"};
  const bool v5_or_later = version == ProtocolVersion::V5 || version == ProtocolVersion::V6;
  if (v5_or_later) {
    // render-stream-5.md "Features": /4's list plus instance_params, material and
    // use_parent_material, re-sorted; canvas_state is new.
    features.item_state.push_back("instance_params");
    features.item_state.push_back("material");
    features.item_state.push_back("use_parent_material");
    std::sort(features.item_state.begin(), features.item_state.end());
    features.canvas_state = {"modulate", "transform"};
    if (version == ProtocolVersion::V6) {
      // render-stream-6.md "Features": canvas_state gains "layer", re-sorted.
      features.canvas_state = {"layer", "modulate", "transform"};
    }
  }
  if (headless_host) {
    features.resources = {"texture_2d", "texture_2d_placeholder"};
    features.unsupported_resources = {{"canvas_texture", "canvas-texture-headless"}};
  } else {
    features.resources = {"canvas_texture", "texture_2d", "texture_2d_placeholder"};
  }
  if (version == ProtocolVersion::V4 || v5_or_later) {
    // render-stream-4.md "Features": `resources` gains "mesh", kept sorted by byte value.
    features.resources.push_back("mesh");
    if (v5_or_later) {
      // render-stream-5.md "Features": and "material" and "shader".
      features.resources.push_back("material");
      features.resources.push_back("shader");
    }
    std::sort(features.resources.begin(), features.resources.end());
  }
  features.observed_unsupported_ops = {"canvas_item_add_animation_slice",
                                       "canvas_item_add_circle",
                                       "canvas_item_add_clip_ignore",
                                       "canvas_item_add_lcd_texture_rect_region",
                                       "canvas_item_add_line",
                                       "canvas_item_add_mesh",
                                       "canvas_item_add_msdf_texture_rect_region",
                                       "canvas_item_add_multiline",
                                       "canvas_item_add_multimesh",
                                       "canvas_item_add_nine_patch",
                                       "canvas_item_add_particles",
                                       "canvas_item_add_polygon",
                                       "canvas_item_add_polyline",
                                       "canvas_item_add_primitive",
                                       "canvas_item_add_set_transform",
                                       "canvas_item_add_triangle_array",
                                       "canvas_item_attach_skeleton",
                                       "canvas_item_set_material"};
  if (version == ProtocolVersion::V3) {
    // render-stream-3.md "Features": a supported op now, no longer a refused one.
    features.observed_unsupported_ops.erase(
        std::find(features.observed_unsupported_ops.begin(),
                  features.observed_unsupported_ops.end(),
                  "canvas_item_add_msdf_texture_rect_region"));
  } else if (version == ProtocolVersion::V4) {
    // render-stream-4.md "Features": the ten ops that became commands leave; six remain.
    features.observed_unsupported_ops = {"canvas_item_add_animation_slice",
                                         "canvas_item_add_lcd_texture_rect_region",
                                         "canvas_item_add_multimesh",
                                         "canvas_item_add_particles",
                                         "canvas_item_attach_skeleton",
                                         "canvas_item_set_material"};
  } else if (v5_or_later) {
    // render-stream-5.md "Features": /4's six lose canvas_item_set_material (item state now) and
    // gain canvas_light_attach_to_canvas (gate5_5-design.md D10, D16).
    features.observed_unsupported_ops = {"canvas_item_add_animation_slice",
                                         "canvas_item_add_lcd_texture_rect_region",
                                         "canvas_item_add_multimesh",
                                         "canvas_item_add_particles",
                                         "canvas_item_attach_skeleton",
                                         "canvas_light_attach_to_canvas"};
    if (version == ProtocolVersion::V6) {
      // render-stream-6.md "Features": calibrator 9's three typed canvas ops (gate6-design.md
      // D3), sorted by byte value.
      features.observed_unsupported_ops.push_back("canvas_set_item_mirroring");
      features.observed_unsupported_ops.push_back("canvas_set_item_repeat");
      features.observed_unsupported_ops.push_back("canvas_set_parent");
    }
  }
  features.unobserved = {"canvas_item_set_canvas_group_mode",
                         "canvas_item_set_instance_shader_parameter",
                         "canvas_item_set_light_mask",
                         "canvas_item_set_sort_children_by_y",
                         "canvas_item_set_visibility_notifier",
                         "canvas_set_modulate",
                         "canvas_texture_set_shading_parameters",
                         "texture_set_size_override",
                         "viewport_remove_canvas",
                         "viewport_set_canvas_cull_mask",
                         "viewport_set_global_canvas_transform"};
  if (version == ProtocolVersion::V4 || v5_or_later) {
    // render-stream-4.md "Features" (gate3-design.md "Deferred"): the two snap-to-pixel settings.
    features.unobserved.push_back("viewport_set_snap_2d_transforms_to_pixel");
    features.unobserved.push_back("viewport_set_snap_2d_vertices_to_pixel");
  }
  if (v5_or_later) {
    // render-stream-5.md "Features": canvas_item_set_instance_shader_parameter and
    // canvas_set_modulate are observed state now; D16's declared-unobserved names join, sorted.
    const auto drop = [&features](const char *name) {
      const auto it = std::find(features.unobserved.begin(), features.unobserved.end(), name);
      if (it != features.unobserved.end()) {
        features.unobserved.erase(it);
      }
    };
    drop("canvas_item_set_instance_shader_parameter");
    drop("canvas_set_modulate");
    for (const char *name :
         {"canvas_item_set_copy_to_backbuffer", "global_shader_parameter_add",
          "global_shader_parameter_remove", "global_shader_parameter_set",
          "global_shader_parameter_set_override", "material_set_next_pass",
          "material_set_render_priority", "shader_set_path_hint"}) {
      features.unobserved.push_back(name);
    }
    if (version == ProtocolVersion::V6) {
      // render-stream-6.md "Features": calibrator 9 hooks viewport_remove_canvas and
      // viewport_set_global_canvas_transform; slot 440 stays unhooked.
      drop("viewport_remove_canvas");
      drop("viewport_set_global_canvas_transform");
      features.unobserved.push_back("canvas_set_disable_scale");
    }
    std::sort(features.unobserved.begin(), features.unobserved.end());
  }
  features.publication = kPublication;
  return features;
}

void observe_planned_backbuffer_setters(Features *features,
                                        const std::vector<std::string> &hooks_planned) {
  for (const char *name :
       {"canvas_item_set_canvas_group_mode", "canvas_item_set_copy_to_backbuffer"}) {
    if (std::find(hooks_planned.begin(), hooks_planned.end(), name) == hooks_planned.end()) {
      continue;
    }
    const auto it = std::find(features->unobserved.begin(), features->unobserved.end(), name);
    if (it != features->unobserved.end()) {
      features->unobserved.erase(it);
    }
  }
}

ResourcesInfo resources_info(const ResourcePolicy &policy, Fetch out_of_band_fetch) {
  ResourcesInfo info;
  info.inline_max_bytes = policy.inline_max_bytes;
  info.max_payload_bytes = policy.max_payload_bytes;
  info.permitted_formats = policy.permitted_formats;
  if (policy.inline_max_bytes == 0) {
    info.delivery = Delivery::OutOfBand;
  } else if (policy.inline_max_bytes >= policy.max_payload_bytes) {
    info.delivery = Delivery::Inline;
  } else {
    info.delivery = Delivery::Mixed;
  }
  info.fetch = info.delivery == Delivery::Inline ? Fetch::None : out_of_band_fetch;
  info.has_http_path = info.fetch == Fetch::Http;
  info.http_path = info.has_http_path ? "/resources/sha256/" : "";
  info.auth = Auth::None;
  info.decode = policy.decode;
  info.texture_delivery = policy.texture_delivery;
  return info;
}

// ----------------------------------------------------------------- Publisher

Publisher::Publisher(RecordSink *full, RecordSink *patch, SabotageConfig sabotage,
                     ResourcePolicy policy, rs::ResourceStore *store)
    : sabotage_(std::move(sabotage)), policy_(std::move(policy)), store_(store) {
  lanes_[0].sink = full;
  lanes_[0].encoding = Encoding::Full;
  lanes_[1].sink = patch;
  lanes_[1].encoding = Encoding::Patch;
  if (store_ != nullptr && sabotage_.kind == SabotageKind::WrongHash) {
    store_->set_wrong_hash_frame(sabotage_.frame);
  }
}

bool Publisher::start(const Session &tmpl) {
  if (lanes_[0].sink == nullptr && lanes_[1].sink == nullptr) {
    return false;
  }
  bool ok = true;
  const std::vector<std::uint8_t> magic_bytes = magic(tmpl.version);
  // G8w: a /8 file sink publishes /8 transactions (the mirror stamps its snapshots V6).
  stamp_v8_ = is_v8_or_later(tmpl.version);
  stamp_version_ = tmpl.version;
  for (Lane &lane : lanes_) {
    if (lane.sink == nullptr) {
      continue;
    }
    lane.session = tmpl;
    lane.session.stream.stream_id = generate_id();
    lane.session.stream.has_connection = false;
    lane.session.stream.connection = 0;
    lane.session.stream.transport = Transport::File;
    lane.session.stream.encoding = lane.encoding;
    lane.session.resources = resources_info(policy_, Fetch::Directory);
    const std::uint64_t t0 = monotonic_ns();
    const std::vector<std::uint8_t> session_bytes = encode_session(lane.session);
    const std::uint64_t t1 = monotonic_ns();
    if (!lane.sink->write(magic_bytes) || !lane.sink->write(session_bytes) ||
        !lane.sink->flush()) {
      ok = false;
      continue;
    }
    // bytes_total counts the magic too (render-stream-0.md "End record", unchanged at /2).
    lane.stats.bytes_total += magic_bytes.size();
    note_record_bytes(&lane.stats, session_bytes);
    lane.stats.encode_ns_total = saturating_add(lane.stats.encode_ns_total, t1 - t0);
  }
  return ok;
}

bool Publisher::write_transaction(Lane *lane, const Transaction &transaction,
                                  std::uint64_t form_ns, std::uint64_t diff_ns,
                                  std::uint64_t snapshot_ns) {
  const std::uint64_t t0 = monotonic_ns();
  const std::vector<std::uint8_t> bytes = encode_transaction(transaction);
  const std::uint64_t t1 = monotonic_ns();
  if (!lane->sink->write(bytes) || !lane->sink->flush()) {
    return false;
  }
  ++lane->transactions;
  if (transaction.encoding == Encoding::Full) {
    ++lane->stats.full_transactions;
  } else {
    ++lane->stats.patch_transactions;
  }
  note_record_bytes(&lane->stats, bytes);
  lane->stats.encode_ns_total = saturating_add(lane->stats.encode_ns_total, form_ns + (t1 - t0));
  lane->stats.diff_ns_total = saturating_add(lane->stats.diff_ns_total, diff_ns);
  lane->stats.snapshot_ns_total = saturating_add(lane->stats.snapshot_ns_total, snapshot_ns);
  return true;
}

bool Publisher::write_inline(Lane *lane, const rs::Captured &published, std::uint64_t frame) {
  if (policy_.inline_max_bytes == 0) {
    return true;
  }
  // render-stream-2.md "Resource record": one record per hash the stream has not carried yet,
  // before the first transaction whose resolved table holds it, in table (id) order -- textures,
  // then (G5e, render-stream-4.md) every `ok` mesh's surfaces.
  for (const rs::PayloadRef &ref : rs::payload_refs(published.state)) {
    const std::string &hash = *ref.hash;
    if (ref.payload_bytes > policy_.inline_max_bytes || lane->carried.count(hash) != 0) {
      continue;
    }
    const auto payload = published.payloads.find(hash);
    if (payload == published.payloads.end() || payload->second == nullptr) {
      error_ = "resource-store-failed: no payload for hash " + hash;
      return false;
    }
    ResourceRecord record;
    record.hash = hash;
    record.payload = *payload->second;
    const std::vector<std::uint8_t> bytes = encode_resource(record);
    const bool ok = lane->sink->write(bytes) && lane->sink->flush();
    if (events_) {
      events_("inline", hash, record.payload.size(), ok, frame);
    }
    if (!ok) {
      return false;
    }
    lane->carried.insert(hash);
    ++lane->stats.resource_records;
    lane->stats.resource_bytes += record.payload.size();
    note_record_bytes(&lane->stats, bytes);
  }
  return true;
}

bool Publisher::store_payloads(const rs::Captured &published, std::uint64_t frame) {
  for (const rs::PayloadRef &ref : rs::payload_refs(published.state)) {
    const std::string &hash = *ref.hash;
    if (store_ == nullptr) {
      if (ref.payload_bytes > policy_.inline_max_bytes) {
        error_ = "resource-store-missing: hash " + hash + " (" +
                 std::to_string(ref.payload_bytes) + " B) is above the inline threshold and " +
                 "no store directory is open";
        return false;
      }
      continue;
    }
    if (store_->has(hash)) {
      continue;
    }
    const auto payload = published.payloads.find(hash);
    if (payload == published.payloads.end() || payload->second == nullptr) {
      error_ = "resource-store-failed: no payload for hash " + hash;
      return false;
    }
    std::string why;
    const rs::ResourceStore::Put put =
        ref.texture != nullptr  ? store_->put(*ref.texture, payload->second, frame, &why)
        : ref.surface != nullptr ? store_->put_mesh(*ref.surface, payload->second, frame, &why)
                                 : store_->put_shader(*ref.shader, payload->second, frame, &why);
    if (events_ && put != rs::ResourceStore::Put::Present) {
      events_("store", hash, payload->second->size(), put == rs::ResourceStore::Put::Stored,
              frame);
    }
    if (put == rs::ResourceStore::Put::Failed) {
      error_ = "resource-store-failed: " + why;
      return false;
    }
  }
  // G8kp (texture-delivery-design.md Q3 "File sink"): the store holds every variant produced, so a
  // replaying receiver picks by D3 as a live one does. A variant is never inline (D12(c), Q5) and
  // never required: without a store it is simply not carried.
  if (store_ == nullptr) {
    return true;
  }
  for (const TextureEntry &entry : published.state.textures) {
    if (!is_ok_image(entry)) {
      continue;
    }
    for (const rs2::TextureVariant &variant : entry.variants) {
      // G8kp's `block` (`<hash>.grt`) and G8ku's `uastc` (`<hash>.ktx2`, render-stream-9.md "KTX2
      // payload"); etc1s is G8ke's.
      if ((variant.encoding != rs2::VariantEncoding::Block &&
           variant.encoding != rs2::VariantEncoding::Uastc) ||
          store_->has(variant.hash)) {
        continue;
      }
      const auto payload = published.payloads.find(variant.hash);
      if (payload == published.payloads.end() || payload->second == nullptr) {
        error_ = "resource-store-failed: no payload for variant hash " + variant.hash;
        return false;
      }
      std::string why;
      const rs::ResourceStore::Put put =
          store_->put_variant(entry, variant, payload->second, frame, &why);
      if (events_ && put != rs::ResourceStore::Put::Present) {
        events_("store", variant.hash, payload->second->size(),
                put == rs::ResourceStore::Put::Stored, frame);
      }
      if (put == rs::ResourceStore::Put::Failed) {
        error_ = "resource-store-failed: " + why;
        return false;
      }
    }
  }
  return true;
}

void Publisher::apply_stale_texture(rs::Captured *captured, std::uint64_t frame) {
  if (sabotage_.kind != SabotageKind::StaleTexture || frame < sabotage_.frame) {
    return;
  }
  if (stale_id_ == 0 && has_previous_) {
    // The lowest-id texture whose entry changed at or after the sabotage frame keeps the
    // version, hash and payload it had before the change (gate2-design.md G2b2).
    for (const TextureEntry &entry : captured->state.textures) {
      const auto before = std::find_if(
          previous_.state.textures.begin(), previous_.state.textures.end(),
          [&entry](const TextureEntry &e) { return e.id == entry.id; });
      if (before == previous_.state.textures.end() || before->version == entry.version) {
        continue;
      }
      stale_id_ = entry.id;
      stale_entry_ = *before;
      stale_payload_.reset();
      if (is_ok_image(*before)) {
        const auto payload = previous_.payloads.find(before->hash);
        if (payload != previous_.payloads.end()) {
          stale_payload_ = payload->second;
        }
      }
      break;
    }
  }
  if (stale_id_ == 0) {
    return;
  }
  for (TextureEntry &entry : captured->state.textures) {
    if (entry.id != stale_id_) {
      continue;
    }
    entry = stale_entry_;
    break;
  }
  // The payload map holds exactly the ok image hashes of the (sabotaged) table, and (G5e) the
  // mesh surfaces' hashes, which this sabotage never touches.
  rs::PayloadMap payloads;
  for (const TextureEntry &entry : captured->state.textures) {
    if (!is_ok_image(entry)) {
      continue;
    }
    const auto it = captured->payloads.find(entry.hash);
    if (it != captured->payloads.end()) {
      payloads.emplace(entry.hash, it->second);
    } else if (entry.id == stale_id_ && stale_payload_ != nullptr) {
      payloads.emplace(entry.hash, stale_payload_);
    }
    // G8kp: an entry's variants travel with it (the stale one's from the previous frame).
    for (const rs2::TextureVariant &variant : entry.variants) {
      const auto v = captured->payloads.find(variant.hash);
      if (v != captured->payloads.end()) {
        payloads.emplace(variant.hash, v->second);
      } else if (entry.id == stale_id_) {
        const auto old = previous_.payloads.find(variant.hash);
        if (old != previous_.payloads.end()) {
          payloads.emplace(variant.hash, old->second);
        }
      }
    }
  }
  for (const MeshEntry &mesh : captured->state.meshes) {
    for (const MeshSurface &surface : mesh.surfaces) {
      const auto it = captured->payloads.find(surface.hash);
      if (it != captured->payloads.end()) {
        payloads.emplace(surface.hash, it->second);
      }
    }
  }
  // G55d: shader code payloads, likewise untouched.
  for (const ShaderEntry &shader : captured->state.shaders) {
    if (!shader.has_hash) {
      continue;
    }
    const auto it = captured->payloads.find(shader.hash);
    if (it != captured->payloads.end()) {
      payloads.emplace(shader.hash, it->second);
    }
  }
  captured->payloads = std::move(payloads);
}

bool Publisher::publish(rs::Captured captured, std::uint64_t frame, std::uint64_t snapshot_ns) {
  if (finished_) {
    return false;
  }
  // The one published copy (gate0-design.md "Publication" sabotages, unchanged at gate 1).
  const bool sabotage_frame_reached = frame >= sabotage_.frame;
  rs::Captured published;
  if (sabotage_.kind == SabotageKind::FreezeFrame && sabotage_frame_reached && has_frozen_) {
    // Republish the content from the transaction before frame F, untouched.
    published = frozen_;
  } else {
    if (sabotage_.kind == SabotageKind::PerturbTransform && sabotage_frame_reached) {
      for (ItemState &item : captured.state.items) {
        item.xform[4] += 1.0f;  // origin.x
      }
    }
    apply_stale_texture(&captured, frame);
    if (sabotage_.kind == SabotageKind::FreezeFrame) {
      // Keep the pre-sabotage copy available for when freezing starts.
      frozen_ = captured;
      has_frozen_ = true;
    }
    published = std::move(captured);
  }
  published.state.seq = next_seq_++;
  published.state.frame = frame;
  if (stamp_v8_) {
    published.state.version = stamp_version_;
  }

  // Out of band first: every payload the transactions below name is in the store before any
  // sink can be read (gate2-design.md Q4 "File sinks").
  if (!store_payloads(published, frame)) {
    return false;
  }

  bool ok = true;
  Lane &full = lanes_[0];
  if (full.sink != nullptr) {
    const std::uint64_t t0 = monotonic_ns();
    const Transaction transaction = make_full(published.state);
    const std::uint64_t t1 = monotonic_ns();
    ok = write_inline(&full, published, frame) &&
         write_transaction(&full, transaction, t1 - t0, 0, snapshot_ns) && ok;
  }

  Lane &patch = lanes_[1];
  if (patch.sink != nullptr) {
    Transaction transaction;
    std::uint64_t form_ns = 0;
    std::uint64_t diff_ns = 0;
    const std::uint64_t t0 = monotonic_ns();
    if (!has_previous_) {
      // A patch stream starts full (render-stream-1.md "Session record": `encoding`).
      transaction = make_full(published.state);
      form_ns = monotonic_ns() - t0;
    } else {
      // base_seq = previous_.seq = seq - 1: both sinks advance together.
      transaction = make_patch(previous_.state, published.state);
      diff_ns = monotonic_ns() - t0;
    }
    if (sabotage_.kind == SabotageKind::PatchDropItem && frame == sabotage_.frame &&
        !transaction.items.empty()) {
      // Entries are ascending by id, so the last one is the highest id. Only this transaction
      // loses it: `previous_` below stays the true published snapshot, so the receiver's state
      // diverges until that item changes again.
      transaction.items.pop_back();
    }
    ok = write_inline(&patch, published, frame) &&
         write_transaction(&patch, transaction, form_ns, diff_ns, snapshot_ns) && ok;
  }
  // Kept with or without a patch sink: the patch sink's next base, and the copy the live
  // adapter delivers (last_published()).
  previous_ = std::move(published);
  has_previous_ = true;
  return ok;
}

bool Publisher::finish(EndReason reason) {
  if (finished_) {
    return true;
  }
  finished_ = true;
  bool ok = true;
  for (Lane &lane : lanes_) {
    if (lane.sink == nullptr) {
      continue;
    }
    End end;
    end.transactions = lane.transactions;
    end.reason = reason;
    end.stats = lane.stats;
    const std::vector<std::uint8_t> bytes = encode_end(end);
    ok = lane.sink->write(bytes) && lane.sink->flush() && ok;
    lane.sink->close();
  }
  return ok;
}

}  // namespace rs2
}  // namespace grc
