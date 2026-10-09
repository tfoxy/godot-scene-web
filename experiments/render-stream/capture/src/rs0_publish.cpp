#include "rs0_publish.h"

#include <sys/random.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cerrno>
#include <cstdlib>

#include "report.h"
#include "rs0_codec.h"

namespace grc {
namespace rs0 {

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

ParseResult parse_sabotage(const char *kind, const char *frame_str) {
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
  } else {
    result.ok = false;
    result.error = "unknown GRC_SABOTAGE kind \"" + kind_text + "\"";
    return result;
  }

  if (frame_str == nullptr) {
    result.config.frame = 21;
    return result;
  }
  const std::string frame_text(frame_str);
  const bool all_digits =
      !frame_text.empty() &&
      std::all_of(frame_text.begin(), frame_text.end(),
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

std::string generate_session_id() {
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

Features gate0_features() {
  Features features;
  features.ops = {"add_rect"};
  features.item_state = {"children",         "clip",    "custom_rect",   "draw_index",
                         "modulate",         "parent",  "self_modulate", "transform",
                         "visibility_layer", "visible", "z_index"};
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
  features.unobserved = {"canvas_item_set_canvas_group_mode",
                         "canvas_item_set_default_texture_filter",
                         "canvas_item_set_default_texture_repeat",
                         "canvas_item_set_draw_behind_parent",
                         "canvas_item_set_instance_shader_parameter",
                         "canvas_item_set_light_mask",
                         "canvas_item_set_sort_children_by_y",
                         "canvas_item_set_z_as_relative_to_parent",
                         "canvas_set_modulate",
                         "viewport_remove_canvas",
                         "viewport_set_canvas_cull_mask"};
  features.publication = kPublication;
  return features;
}

// ----------------------------------------------------------------- Publisher

Publisher::Publisher(RecordSink &sink, SabotageConfig sabotage) : sink_(sink), sabotage_(sabotage) {}

void Publisher::note_record_bytes(const std::vector<std::uint8_t> &bytes) {
  stats_.bytes_total += bytes.size();
  stats_.max_record_bytes = std::max(stats_.max_record_bytes, static_cast<std::uint64_t>(bytes.size()));
}

bool Publisher::start(const Session &session) {
  const std::vector<std::uint8_t> magic_bytes = magic();
  const std::uint64_t t0 = monotonic_ns();
  const std::vector<std::uint8_t> session_bytes = encode_session(session);
  const std::uint64_t t1 = monotonic_ns();
  if (!sink_.write(magic_bytes) || !sink_.write(session_bytes) || !sink_.flush()) {
    return false;
  }
  stats_.bytes_total += magic_bytes.size();
  note_record_bytes(session_bytes);
  stats_.encode_ns_total = saturating_add(stats_.encode_ns_total, t1 - t0);
  return true;
}

bool Publisher::publish_encoded(const Snapshot &snapshot, std::uint64_t snapshot_ns) {
  const std::uint64_t t0 = monotonic_ns();
  const std::vector<std::uint8_t> bytes = encode_transaction(snapshot);
  const std::uint64_t t1 = monotonic_ns();
  if (!sink_.write(bytes) || !sink_.flush()) {
    return false;
  }
  ++transactions_;
  note_record_bytes(bytes);
  stats_.encode_ns_total = saturating_add(stats_.encode_ns_total, t1 - t0);
  stats_.snapshot_ns_total = saturating_add(stats_.snapshot_ns_total, snapshot_ns);
  return true;
}

bool Publisher::publish_transaction(Snapshot snapshot, std::uint64_t frame_number,
                                     std::uint64_t snapshot_ns) {
  const bool sabotage_frame_reached = frame_number >= sabotage_.frame;
  Snapshot to_publish;
  if (sabotage_.kind == SabotageKind::FreezeFrame && sabotage_frame_reached && has_frozen_) {
    // Republish the content from the transaction before frame F, untouched.
    to_publish = frozen_snapshot_;
  } else {
    if (sabotage_.kind == SabotageKind::PerturbTransform && sabotage_frame_reached) {
      for (ItemState &item : snapshot.items) {
        item.xform[4] += 1.0f;  // origin.x
      }
    }
    to_publish = snapshot;
    if (sabotage_.kind == SabotageKind::FreezeFrame) {
      // Keep the pre-sabotage copy available for when freezing starts.
      frozen_snapshot_ = snapshot;
      has_frozen_ = true;
    }
  }
  to_publish.seq = next_seq_++;
  to_publish.frame = frame_number;
  return publish_encoded(to_publish, snapshot_ns);
}

bool Publisher::finish(EndReason reason) {
  End end;
  end.transactions = transactions_;
  end.reason = reason;
  end.stats = stats_;
  const std::vector<std::uint8_t> bytes = encode_end(end);
  const bool ok = sink_.write(bytes) && sink_.flush();
  sink_.close();
  return ok;
}

}  // namespace rs0
}  // namespace grc
