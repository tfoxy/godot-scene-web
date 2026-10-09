// render-stream/1 file publication (gate 1, G1b2): the record sinks, stream/session ids, the
// gate-1 session features, the sabotage environment, and a Publisher that writes one snapshot per
// frame to up to two file sinks -- a `full` sink and a `patch` sink (protocol/gate1-design.md
// "G1b2" and Q4 "Frame callback": "file sinks: full sink writes full(snap); patch sink writes
// patch(prev_file_snap, snap)").
//
// Wire format: protocol/render-stream-1.md ("File layout", "Session record", "Transaction
// record", "End record"). Encoding goes through rs1_codec and the patch diff through rs1_diff;
// this file only sequences records, applies the publisher-side sabotages and keeps per-sink
// stats.
//
// Sabotages handled here: `freeze-frame` and `perturb-transform` (as at gate 0, applied to the
// one published copy both sinks share) and `patch-drop-item` (patch sink only). `omit-update`
// and `omit-op` live in the mirror (rs_mirror.h); the live kinds (`drop-message`,
// `ignore-credit`, `stale-coalesce`) are refused until the live adapter exists (G1c2).
#ifndef GRC_RS1_PUBLISH_H
#define GRC_RS1_PUBLISH_H

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs1_snapshot.h"

namespace grc {
namespace rs1 {

// Where published record bytes go. The sequencing a caller must follow is one or two write()
// calls, then one flush() -- magic + session at start, one transaction record per frame
// callback, one end record at shutdown or disarm (gate0-design.md "Publication": "One fwrite and
// one fflush per record").
class RecordSink {
 public:
  virtual ~RecordSink() = default;

  // Creates or truncates `path`, creating any missing parent directory.
  virtual bool open(const std::string &path) = 0;
  // Appends `bytes`. No implicit flush.
  virtual bool write(const std::vector<std::uint8_t> &bytes) = 0;
  virtual bool flush() = 0;
  virtual void close() = 0;
};

// fopen(path, "wb"). The production sink.
class FileRecordSink : public RecordSink {
 public:
  FileRecordSink() = default;
  ~FileRecordSink() override;
  FileRecordSink(const FileRecordSink &) = delete;
  FileRecordSink &operator=(const FileRecordSink &) = delete;

  bool open(const std::string &path) override;
  bool write(const std::vector<std::uint8_t> &bytes) override;
  bool flush() override;
  void close() override;

 private:
  std::FILE *file_ = nullptr;
};

// Records every call in memory; no disk I/O. For unit tests.
class MemoryRecordSink : public RecordSink {
 public:
  bool open(const std::string &path) override;
  bool write(const std::vector<std::uint8_t> &bytes) override;
  bool flush() override;
  void close() override;

  std::string opened_path;
  std::vector<std::uint8_t> bytes;  // every write(), concatenated in call order
  std::vector<std::size_t> writes;  // the byte length of each write() call, in order
  int flush_count = 0;
  bool is_open = false;
  bool was_closed = false;
};

// GRC_SABOTAGE / GRC_SABOTAGE_FRAME / GRC_SABOTAGE_OP, already validated by parse_sabotage().
struct SabotageConfig {
  SabotageKind kind = SabotageKind::None;
  std::uint64_t frame = 21;  // render-stream-0.md "Environment" default
  std::string op;            // the RenderingServer method name; set only for OmitOp
};

struct ParseResult {
  bool ok = true;
  SabotageConfig config;
  std::string error;  // set when !ok
};

// `kind`, `frame` and `op` are the raw GRC_SABOTAGE / GRC_SABOTAGE_FRAME / GRC_SABOTAGE_OP values,
// or nullptr when the variable is unset. An unset `kind` is ok with SabotageKind::None (the
// other two are then ignored, as the caller reads them only when GRC_SABOTAGE is set).
//
// Accepted: freeze-frame, omit-update, perturb-transform, patch-drop-item, and omit-op with a
// non-empty `op` matching [a-z0-9_]+. Refused (ok false, `error` says why; the caller must then
// publish nothing): the live kinds drop-message, ignore-credit and stale-coalesce (no live
// adapter yet, G1c2), any other kind, a `frame` that is not a decimal integer >= 1 (digits only,
// no sign), and a non-empty `op` with any kind other than omit-op.
ParseResult parse_sabotage(const char *kind, const char *frame, const char *op);

// 32 lowercase hex characters: 128 random bits from getrandom(). Used for both session_id and
// stream_id (render-stream-1.md "Session record").
std::string generate_id();

// The constant gate-1 session `features` (render-stream-1.md "Session record"): gate 0's lists
// with item_state += "behind", "z_relative" and unobserved += "viewport_set_global_canvas_transform",
// each array sorted ascending by byte value; publication "snapshot-or-patch".
Features gate1_features();

// Writes render-stream/1 recordings to up to two file sinks from one snapshot per frame. Not
// thread-safe; entry.cpp calls it only from the frame callback (and at arm / shutdown).
class Publisher {
 public:
  // Either sink may be null, not both (start() then fails). The sinks are not owned and must be
  // open already.
  Publisher(RecordSink *full, RecordSink *patch, SabotageConfig sabotage = SabotageConfig());

  // Writes the magic and a session record to each sink (one flush per sink). Each sink's session
  // is `tmpl` (same session_id) with its own fresh stream_id, transport file, connection null and
  // encoding full / patch. Returns false when there is no sink or a write fails.
  bool start(const Session &tmpl);

  // One call per armed frame callback. `frame` is the capture host's frames_total; `snapshot_ns`
  // is the mirror's lock-held copy time, measured by the caller and added to both sinks'
  // snapshot_ns_total. Forms ONE published copy (freeze-frame / perturb-transform applied), gives
  // it the next seq (contiguous from 1, shared by both sinks), and writes:
  //   full sink:  make_full(published), every frame;
  //   patch sink: make_full(published) the first time, then make_patch(previous published,
  //               published) with base_seq = seq - 1; under patch-drop-item, at exactly
  //               frame == sabotage.frame, the highest-id item entry (if any) is left out of that
  //               one transaction, while the next patch is still diffed against the true
  //               published snapshot.
  // Returns false when a write fails.
  bool publish(Snapshot snapshot, std::uint64_t frame, std::uint64_t snapshot_ns);

  // Writes each sink's end record (with its stats so far; the end record's own bytes are not
  // added to them) and closes the sink. Only the first call does anything.
  bool finish(EndReason reason);

  bool has_sink(Encoding encoding) const { return lane(encoding).sink != nullptr; }
  // The session record written to that sink (valid after start()).
  const Session &session(Encoding encoding) const { return lane(encoding).session; }
  std::uint64_t transactions(Encoding encoding) const { return lane(encoding).transactions; }
  const EndStats &stats(Encoding encoding) const { return lane(encoding).stats; }
  const SabotageConfig &sabotage() const { return sabotage_; }

 private:
  struct Lane {
    RecordSink *sink = nullptr;
    Encoding encoding = Encoding::Full;
    Session session;
    std::uint64_t transactions = 0;
    EndStats stats;
  };

  const Lane &lane(Encoding encoding) const {
    return encoding == Encoding::Full ? lanes_[0] : lanes_[1];
  }
  bool write_transaction(Lane *lane, const Transaction &transaction, std::uint64_t form_ns,
                         std::uint64_t diff_ns, std::uint64_t snapshot_ns);

  Lane lanes_[2];  // [0] full, [1] patch
  SabotageConfig sabotage_;
  std::uint64_t next_seq_ = 1;
  bool finished_ = false;
  // The previous published snapshot: the patch sink's base. Kept only with a patch sink.
  Snapshot previous_;
  bool has_previous_ = false;
  // The last published, pre-sabotage content: what freeze-frame republishes once
  // GRC_SABOTAGE_FRAME is reached. Kept only under freeze-frame.
  Snapshot frozen_;
  bool has_frozen_ = false;
};

}  // namespace rs1
}  // namespace grc

#endif  // GRC_RS1_PUBLISH_H
