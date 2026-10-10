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
  return std::fwrite(bytes.data(), 1, bytes.size(), file_) == bytes.size();
}

bool FileRecordSink::flush() { return file_ != nullptr && std::fflush(file_) == 0; }

void FileRecordSink::close() {
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
  }
  features.item_state = {"behind",         "children",         "clip",           "custom_rect",
                         "draw_index",     "modulate",         "parent",         "self_modulate",
                         "texture_filter", "texture_repeat",   "transform",      "visibility_layer",
                         "visible",        "z_index",          "z_relative"};
  if (headless_host) {
    features.resources = {"texture_2d", "texture_2d_placeholder"};
    features.unsupported_resources = {{"canvas_texture", "canvas-texture-headless"}};
  } else {
    features.resources = {"canvas_texture", "texture_2d", "texture_2d_placeholder"};
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
  features.publication = kPublication;
  return features;
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
  // before the first transaction whose resolved table holds it, in table (id) order.
  for (const TextureEntry &entry : published.state.textures) {
    if (!is_ok_image(entry) || entry.payload_bytes > policy_.inline_max_bytes ||
        lane->carried.count(entry.hash) != 0) {
      continue;
    }
    const auto payload = published.payloads.find(entry.hash);
    if (payload == published.payloads.end() || payload->second == nullptr) {
      error_ = "resource-store-failed: no payload for hash " + entry.hash;
      return false;
    }
    ResourceRecord record;
    record.hash = entry.hash;
    record.payload = *payload->second;
    const std::vector<std::uint8_t> bytes = encode_resource(record);
    const bool ok = lane->sink->write(bytes) && lane->sink->flush();
    if (events_) {
      events_("inline", entry.hash, record.payload.size(), ok, frame);
    }
    if (!ok) {
      return false;
    }
    lane->carried.insert(entry.hash);
    ++lane->stats.resource_records;
    lane->stats.resource_bytes += record.payload.size();
    note_record_bytes(&lane->stats, bytes);
  }
  return true;
}

bool Publisher::store_payloads(const rs::Captured &published, std::uint64_t frame) {
  for (const TextureEntry &entry : published.state.textures) {
    if (!is_ok_image(entry)) {
      continue;
    }
    if (store_ == nullptr) {
      if (entry.payload_bytes > policy_.inline_max_bytes) {
        error_ = "resource-store-missing: hash " + entry.hash + " (" +
                 std::to_string(entry.payload_bytes) + " B) is above the inline threshold and " +
                 "no store directory is open";
        return false;
      }
      continue;
    }
    if (store_->has(entry.hash)) {
      continue;
    }
    const auto payload = published.payloads.find(entry.hash);
    if (payload == published.payloads.end() || payload->second == nullptr) {
      error_ = "resource-store-failed: no payload for hash " + entry.hash;
      return false;
    }
    std::string why;
    const rs::ResourceStore::Put put = store_->put(entry, *payload->second, frame, &why);
    if (events_ && put != rs::ResourceStore::Put::Present) {
      events_("store", entry.hash, payload->second->size(), put == rs::ResourceStore::Put::Stored,
              frame);
    }
    if (put == rs::ResourceStore::Put::Failed) {
      error_ = "resource-store-failed: " + why;
      return false;
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
  // The payload map holds exactly the ok image hashes of the (sabotaged) table.
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
