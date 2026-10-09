#include "rs1_publish.h"

#include <sys/random.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <utility>

#include "report.h"
#include "rs1_codec.h"
#include "rs1_diff.h"

namespace grc {
namespace rs1 {

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
  if (kind_text == "freeze-frame") {
    result.config.kind = SabotageKind::FreezeFrame;
  } else if (kind_text == "omit-update") {
    result.config.kind = SabotageKind::OmitUpdate;
  } else if (kind_text == "perturb-transform") {
    result.config.kind = SabotageKind::PerturbTransform;
  } else if (kind_text == "omit-op") {
    result.config.kind = SabotageKind::OmitOp;
  } else if (kind_text == "patch-drop-item") {
    result.config.kind = SabotageKind::PatchDropItem;
  } else if (kind_text == "drop-message") {
    result.config.kind = SabotageKind::DropMessage;
  } else if (kind_text == "ignore-credit") {
    result.config.kind = SabotageKind::IgnoreCredit;
  } else if (kind_text == "stale-coalesce") {
    result.config.kind = SabotageKind::StaleCoalesce;
  } else {
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

Features gate1_features() {
  Features features;
  features.ops = {"add_rect"};
  features.item_state = {"behind",     "children",         "clip",    "custom_rect",
                         "draw_index", "modulate",         "parent",  "self_modulate",
                         "transform",  "visibility_layer", "visible", "z_index",
                         "z_relative"};
  features.observed_unsupported_ops = {"canvas_item_add_circle",
                                       "canvas_item_add_line",
                                       "canvas_item_add_mesh",
                                       "canvas_item_add_msdf_texture_rect_region",
                                       "canvas_item_add_multimesh",
                                       "canvas_item_add_nine_patch",
                                       "canvas_item_add_polygon",
                                       "canvas_item_add_polyline",
                                       "canvas_item_add_primitive",
                                       "canvas_item_add_set_transform",
                                       "canvas_item_add_texture_rect",
                                       "canvas_item_add_texture_rect_region",
                                       "canvas_item_add_triangle_array",
                                       "canvas_item_set_material"};
  // G1e hooks canvas_item_set_z_as_relative_to_parent and
  // canvas_item_set_draw_behind_parent, so both leave this list (render-stream-1.md
  // "Session record").
  features.unobserved = {"canvas_item_set_canvas_group_mode",
                         "canvas_item_set_default_texture_filter",
                         "canvas_item_set_default_texture_repeat",
                         "canvas_item_set_instance_shader_parameter",
                         "canvas_item_set_light_mask",
                         "canvas_item_set_sort_children_by_y",
                         "canvas_set_modulate",
                         "viewport_remove_canvas",
                         "viewport_set_canvas_cull_mask",
                         "viewport_set_global_canvas_transform"};
  features.publication = kPublication;
  return features;
}

// ----------------------------------------------------------------- Publisher

Publisher::Publisher(RecordSink *full, RecordSink *patch, SabotageConfig sabotage)
    : sabotage_(std::move(sabotage)) {
  lanes_[0].sink = full;
  lanes_[0].encoding = Encoding::Full;
  lanes_[1].sink = patch;
  lanes_[1].encoding = Encoding::Patch;
}

bool Publisher::start(const Session &tmpl) {
  if (lanes_[0].sink == nullptr && lanes_[1].sink == nullptr) {
    return false;
  }
  bool ok = true;
  const std::vector<std::uint8_t> magic_bytes = magic();
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
    const std::uint64_t t0 = monotonic_ns();
    const std::vector<std::uint8_t> session_bytes = encode_session(lane.session);
    const std::uint64_t t1 = monotonic_ns();
    if (!lane.sink->write(magic_bytes) || !lane.sink->write(session_bytes) ||
        !lane.sink->flush()) {
      ok = false;
      continue;
    }
    // bytes_total counts the magic too (render-stream-0.md "End record", unchanged at /1).
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

bool Publisher::publish(Snapshot snapshot, std::uint64_t frame, std::uint64_t snapshot_ns) {
  if (finished_) {
    return false;
  }
  // The one published copy (gate0-design.md "Publication" sabotages, unchanged at gate 1).
  const bool sabotage_frame_reached = frame >= sabotage_.frame;
  Snapshot published;
  if (sabotage_.kind == SabotageKind::FreezeFrame && sabotage_frame_reached && has_frozen_) {
    // Republish the content from the transaction before frame F, untouched.
    published = frozen_;
  } else {
    if (sabotage_.kind == SabotageKind::PerturbTransform && sabotage_frame_reached) {
      for (ItemState &item : snapshot.items) {
        item.xform[4] += 1.0f;  // origin.x
      }
    }
    if (sabotage_.kind == SabotageKind::FreezeFrame) {
      // Keep the pre-sabotage copy available for when freezing starts.
      frozen_ = snapshot;
      has_frozen_ = true;
    }
    published = std::move(snapshot);
  }
  published.seq = next_seq_++;
  published.frame = frame;

  bool ok = true;
  Lane &full = lanes_[0];
  if (full.sink != nullptr) {
    const std::uint64_t t0 = monotonic_ns();
    const Transaction transaction = make_full(published);
    const std::uint64_t t1 = monotonic_ns();
    ok = write_transaction(&full, transaction, t1 - t0, 0, snapshot_ns) && ok;
  }

  Lane &patch = lanes_[1];
  if (patch.sink != nullptr) {
    Transaction transaction;
    std::uint64_t form_ns = 0;
    std::uint64_t diff_ns = 0;
    const std::uint64_t t0 = monotonic_ns();
    if (!has_previous_) {
      // A patch stream starts full (render-stream-1.md "Session record": `encoding`).
      transaction = make_full(published);
      form_ns = monotonic_ns() - t0;
    } else {
      // base_seq = previous_.seq = seq - 1: both sinks advance together.
      transaction = make_patch(previous_, published);
      diff_ns = monotonic_ns() - t0;
    }
    if (sabotage_.kind == SabotageKind::PatchDropItem && frame == sabotage_.frame &&
        !transaction.items.empty()) {
      // Entries are ascending by id, so the last one is the highest id. Only this transaction
      // loses it: `previous_` below stays the true published snapshot, so the receiver's state
      // diverges until that item changes again.
      transaction.items.pop_back();
    }
    ok = write_transaction(&patch, transaction, form_ns, diff_ns, snapshot_ns) && ok;
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

}  // namespace rs1
}  // namespace grc
