// Version-neutral file publication (gate 1 G1b2 as rs1_publish; render-stream/2 since gate 2
// G2b2): the record sinks, stream/session ids, the session features, the sabotage environment,
// the session's resource policy, and a Publisher that writes one snapshot per frame to up to two
// file sinks -- a `full` sink and a `patch` sink (protocol/gate1-design.md "G1b2" and Q4 "Frame
// callback": "file sinks: full sink writes full(snap); patch sink writes patch(prev_file_snap,
// snap)") -- plus, since G2b2, the payloads those snapshots name (gate2-design.md Q4 "File
// sinks"):
//
//   - out of band: every `ok` image hash of each published snapshot that the store directory
//     (rs_resource_store.h, GRC_RESOURCE_STORE_DIR) lacks is written there before the
//     transactions of that frame;
//   - inline: before a transaction is written to a sink, the sink writes one `resource` record
//     for every hash that this stream has not carried yet and whose payload is at most
//     `inline_max_bytes` (each sink for itself), so every recording is self-contained up to its
//     declared threshold.
//
// Wire format: protocol/render-stream-2.md. Encoding goes through rs2_codec and the patch diff
// through rs2_diff; this file only sequences records, applies the publisher-side sabotages and
// keeps per-sink stats.
//
// Sabotages handled here: `freeze-frame` and `perturb-transform` (as at gate 0, applied to the
// one published copy both sinks share), `patch-drop-item` (patch sink only), and (G2b2)
// `stale-texture` (the published copy keeps a texture's pre-change entry and payload) and
// `wrong-hash` (through the store). `omit-update` and `omit-op` live in the mirror
// (rs_mirror.h), `spurious-texture-update` in the mirror and the frame callback (entry.cpp),
// `drop-message` (G1c2), `ignore-credit` and `stale-coalesce` (G1d) in the live hub (rs_live.h).
#ifndef GRC_RS_PUBLISH_H
#define GRC_RS_PUBLISH_H

#include <cstdint>
#include <cstdio>
#include <functional>
#include <set>
#include <string>
#include <vector>

#include "rs2_snapshot.h"
#include "rs_captured.h"
#include "rs_resource_store.h"

namespace grc {
namespace rs2 {

// Where published record bytes go. The sequencing a caller must follow is one or more write()
// calls, then one flush() -- magic + session at start, any resource records and one transaction
// record per frame callback, one end record at shutdown or disarm (gate0-design.md
// "Publication": "One fwrite and one fflush per record").
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
// Accepted: freeze-frame, omit-update, perturb-transform, patch-drop-item, the live kinds
// drop-message, ignore-credit and stale-coalesce (entry.cpp refuses them without
// GRC_LIVE_LISTEN; rs_live.h acts on them), the G2b2 resource kinds stale-texture, wrong-hash
// and spurious-texture-update, the G2c2 serving kinds drop-resource and unpin (entry.cpp refuses
// them without GRC_LIVE_LISTEN; rs_resource_store.h ServedResources acts on them), and omit-op
// with a non-empty `op` matching [a-z0-9_]+. Refused (ok false, `error` says why; the caller
// must then publish nothing): any other kind, a `frame` that is not a decimal integer >= 1
// (digits only, no sign), and a non-empty `op` with any kind other than omit-op.
ParseResult parse_sabotage(const char *kind, const char *frame, const char *op);

// 32 lowercase hex characters: 128 random bits from getrandom(). Used for both session_id and
// stream_id (render-stream-1.md "Session record").
std::string generate_id();

// The constant gate-2 session `features` (render-stream-2.md "Session record"): ops add_rect and
// the two texture-rect draws; item_state gate 1's plus texture_filter and texture_repeat;
// resources texture_2d and texture_2d_placeholder; observed_unsupported_ops gate 1's without the
// two texture-rect draws, plus canvas_item_add_lcd_texture_rect_region and (G3d, calibrator 6)
// canvas_item_add_clip_ignore; unobserved gate 1's without the item default filter/repeat
// setters, plus canvas_texture_set_shading_parameters, texture_set_size_override and (G3d)
// canvas_item_set_visibility_notifier. Each array sorted ascending by byte value; publication
// "snapshot-or-patch". G2d: resources adds canvas_texture, except on a headless host
// (`headless_host`), where unsupported_resources lists it with reason canvas-texture-headless
// instead (protocol/canvas-texture-headless.md).
Features gate2_features(bool headless_host = false);

// The resource policy a capture publishes under (GRC_RESOURCE_*).
struct ResourcePolicy {
  std::vector<std::string> permitted_formats;  // sorted ascending (byte order)
  std::uint64_t max_payload_bytes = 1;
  std::uint64_t inline_max_bytes = 0;
};

// The session's `resources` object (render-stream-2.md "Session record"). `delivery` follows from
// inline_max_bytes: out-of-band at 0, inline at or above max_payload_bytes, mixed otherwise.
// `fetch` is none for inline, else `out_of_band_fetch` (directory for a file recording, http for
// a live stream from G2c2 on); `http_path` is set exactly for http. `auth` is none.
ResourcesInfo resources_info(const ResourcePolicy &policy, Fetch out_of_band_fetch);

// Called once per resource event: op "store" (a payload written to the store directory) or
// "inline" (a resource record written to a sink), its hash, payload size, whether it worked,
// and the frame. entry.cpp writes these to the hook log.
using ResourceEventFn = std::function<void(const char *op, const std::string &hash,
                                           std::uint64_t bytes, bool ok, std::uint64_t frame)>;

// Writes render-stream/2 recordings to up to two file sinks from one snapshot per frame. Not
// thread-safe; entry.cpp calls it only from the frame callback (and at arm / shutdown).
class Publisher {
 public:
  // Either sink may be null, not both (start() then fails). The sinks and the store are not
  // owned; the sinks must be open already. `store` may be null only when every payload travels
  // inline (policy.inline_max_bytes >= policy.max_payload_bytes); a payload neither inline nor
  // storable is the error `resource-store-missing` at the first publish().
  Publisher(RecordSink *full, RecordSink *patch, SabotageConfig sabotage = SabotageConfig(),
            ResourcePolicy policy = ResourcePolicy(), rs::ResourceStore *store = nullptr);

  void set_resource_events(ResourceEventFn fn) { events_ = std::move(fn); }

  // Writes the magic and a session record to each sink (one flush per sink). Each sink's session
  // is `tmpl` (same session_id) with its own fresh stream_id, transport file, connection null,
  // encoding full / patch, and the file `resources` object of this publisher's policy. Returns
  // false when there is no sink or a write fails.
  bool start(const Session &tmpl);

  // One call per armed frame callback. `frame` is the capture host's frames_total;
  // `snapshot_ns` is the mirror's lock-held copy time, measured by the caller and added to both
  // sinks' snapshot_ns_total. Forms ONE published copy (freeze-frame / perturb-transform /
  // stale-texture applied), gives it the next seq (contiguous from 1, shared by both sinks),
  // stores its payloads, and writes:
  //   full sink:  its new inline resource records, then make_full(published), every frame;
  //   patch sink: its new inline resource records, then make_full(published) the first time,
  //               then make_patch(previous published, published) with base_seq = seq - 1; under
  //               patch-drop-item, at exactly frame == sabotage.frame, the highest-id item entry
  //               (if any) is left out of that one transaction, while the next patch is still
  //               diffed against the true published snapshot.
  // Returns false when a write fails; error() then says what (a store failure is
  // "resource-store-failed: ...", a payload with nowhere to go "resource-store-missing").
  bool publish(rs::Captured captured, std::uint64_t frame, std::uint64_t snapshot_ns);

  // Writes each sink's end record (with its stats so far; the end record's own bytes are not
  // added to them) and closes the sink. Only the first call does anything.
  bool finish(EndReason reason);

  bool has_sink(Encoding encoding) const { return lane(encoding).sink != nullptr; }
  // The session record written to that sink (valid after start()).
  const Session &session(Encoding encoding) const { return lane(encoding).session; }
  std::uint64_t transactions(Encoding encoding) const { return lane(encoding).transactions; }
  const EndStats &stats(Encoding encoding) const { return lane(encoding).stats; }
  const SabotageConfig &sabotage() const { return sabotage_; }
  const ResourcePolicy &policy() const { return policy_; }
  const std::string &error() const { return error_; }
  // The one published copy of the last publish() call (sabotages applied, seq and frame set), or
  // null before the first. The live adapter delivers this same copy (gate1-design.md Q4: one
  // snapshot per frame feeds every sink and every connection).
  const rs::Captured *last_published() const { return has_previous_ ? &previous_ : nullptr; }
  // stale-texture: the id it froze (0 until the sabotage found its texture).
  std::uint32_t stale_texture_id() const { return stale_id_; }

 private:
  struct Lane {
    RecordSink *sink = nullptr;
    Encoding encoding = Encoding::Full;
    Session session;
    std::uint64_t transactions = 0;
    EndStats stats;
    std::set<std::string> carried;  // hashes this stream already carried inline
  };

  const Lane &lane(Encoding encoding) const {
    return encoding == Encoding::Full ? lanes_[0] : lanes_[1];
  }
  bool write_transaction(Lane *lane, const Transaction &transaction, std::uint64_t form_ns,
                         std::uint64_t diff_ns, std::uint64_t snapshot_ns);
  bool write_inline(Lane *lane, const rs::Captured &published, std::uint64_t frame);
  bool store_payloads(const rs::Captured &published, std::uint64_t frame);
  void apply_stale_texture(rs::Captured *captured, std::uint64_t frame);

  Lane lanes_[2];  // [0] full, [1] patch
  SabotageConfig sabotage_;
  ResourcePolicy policy_;
  rs::ResourceStore *store_ = nullptr;
  ResourceEventFn events_;
  std::string error_;
  std::uint64_t next_seq_ = 1;
  bool finished_ = false;
  // The previous published snapshot: the patch sink's base and last_published().
  rs::Captured previous_;
  bool has_previous_ = false;
  // The last published, pre-sabotage content: what freeze-frame republishes once
  // GRC_SABOTAGE_FRAME is reached. Kept only under freeze-frame.
  rs::Captured frozen_;
  bool has_frozen_ = false;
  // stale-texture: the frozen texture's id, entry and payload.
  std::uint32_t stale_id_ = 0;
  TextureEntry stale_entry_;
  rs::PayloadPtr stale_payload_;
};

}  // namespace rs2
}  // namespace grc

#endif  // GRC_RS_PUBLISH_H
