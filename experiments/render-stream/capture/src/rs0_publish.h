// render-stream/0 publication: the file sink, session id, stats and the two
// publisher-side sabotages (gate0-design.md "Publication").
//
// `omit-update` is not implemented here: it lives in the mirror (dropping
// mutations stamped GRC_SABOTAGE_FRAME before the publisher ever sees a
// copy), so this file only records its kind in SabotageConfig/the session.
#ifndef GRC_RS0_PUBLISH_H
#define GRC_RS0_PUBLISH_H

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs0_snapshot.h"

namespace grc {
namespace rs0 {

// Where published record bytes go. The sequencing a caller must follow is
// one or two write() calls, then one flush() -- magic + session at arm,
// one transaction record per frame callback, one end record at shutdown or
// disarm (render-stream-0.md "File layout"; gate0-design.md "Publication":
// "One fwrite and one fflush per record").
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

// Records every call in memory; no disk I/O. For unit tests (Publisher "is
// testable against a memory sink").
class MemoryRecordSink : public RecordSink {
 public:
  bool open(const std::string &path) override;
  bool write(const std::vector<std::uint8_t> &bytes) override;
  bool flush() override;
  void close() override;

  std::string opened_path;
  std::vector<std::uint8_t> bytes;    // every write(), concatenated in call order
  std::vector<std::size_t> writes;    // the byte length of each write() call, in order
  int flush_count = 0;
  bool is_open = false;
  bool was_closed = false;
};

// GRC_SABOTAGE / GRC_SABOTAGE_FRAME, already validated by parse_sabotage().
struct SabotageConfig {
  SabotageKind kind = SabotageKind::None;
  std::uint64_t frame = 21;  // render-stream-0.md "Environment" default
};

struct ParseResult {
  bool ok = true;
  SabotageConfig config;
  std::string error;  // set when !ok
};

// `kind` and `frame_str` are the raw GRC_SABOTAGE / GRC_SABOTAGE_FRAME
// values, or nullptr when the variable is unset. Reading the environment
// itself is WP6's job in entry.cpp; this only validates the two strings.
//
// An unset `kind` is ok, with SabotageKind::None. An unknown `kind`, or a
// `frame_str` that is not a decimal integer >= 1 (no sign, no leading '+',
// nothing but digits), is refused: ok is false and error explains why. Per
// gate0-design.md "Publication", a refusal means the caller must not
// publish anything -- no file is created.
ParseResult parse_sabotage(const char *kind, const char *frame_str);

// 32 lowercase hex characters: 128 random bits from getrandom().
std::string generate_session_id();

// The constant gate-0 session `features` (render-stream-0.md "Session record"),
// each array already sorted ascending by byte value.
Features gate0_features();

// Writes a render-stream/0 recording to `sink`: magic + one session record,
// then zero or more transaction records, then one end record. Not
// thread-safe; entry.cpp calls it only from inside the frame callback and
// under the mirror's own lock discipline (gate0-design.md "Publication").
class Publisher {
 public:
  explicit Publisher(RecordSink &sink, SabotageConfig sabotage = SabotageConfig());

  // Writes magic + the session record, with one flush. Returns false on a
  // sink failure.
  bool start(const Session &session);

  // One call per armed frame callback. `frame_number` is the capture host's
  // frames_total; `snapshot_ns` is the mirror's lock-held copy time,
  // measured by the caller and added to stats().snapshot_ns_total as-is.
  // Applies freeze-frame / perturb-transform sabotage to the published copy
  // only (never to `snapshot` itself, which the caller still owns), assigns
  // a fresh contiguous seq, and writes one record with one flush. Returns
  // false on a sink failure.
  bool publish_transaction(Snapshot snapshot, std::uint64_t frame_number,
                            std::uint64_t snapshot_ns);

  // Writes the end record (with the stats accumulated so far; the end
  // record's own bytes are not added to them) and closes the sink.
  bool finish(EndReason reason);

  std::uint64_t transactions() const { return transactions_; }
  const EndStats &stats() const { return stats_; }
  const SabotageConfig &sabotage() const { return sabotage_; }

 private:
  bool publish_encoded(const Snapshot &snapshot, std::uint64_t snapshot_ns);
  void note_record_bytes(const std::vector<std::uint8_t> &bytes);

  RecordSink &sink_;
  SabotageConfig sabotage_;
  std::uint64_t next_seq_ = 1;
  std::uint64_t transactions_ = 0;
  EndStats stats_;
  // The last published, pre-sabotage transaction content: what freeze-frame
  // republishes once GRC_SABOTAGE_FRAME is reached. Only tracked when the
  // configured sabotage is freeze-frame.
  Snapshot frozen_snapshot_;
  bool has_frozen_ = false;
};

}  // namespace rs0
}  // namespace grc

#endif  // GRC_RS0_PUBLISH_H
