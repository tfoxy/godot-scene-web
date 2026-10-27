// render-stream/2 patch diff and resolution: deriving a wire-level Transaction from one or two
// Snapshots, and the inverse. Extends rs1_diff.h with textures (render-stream-2.md "Full and
// patch transactions": "These are as /1, with textures treated like items").
//
// Pure: no I/O, no engine or GDExtension types.
//   make_full()  a full transaction: every canvas/item/texture present, commands never null.
//   make_patch() a patch transaction against `base`: removed_* for ids gone from `cur`, and
//                exactly the canvas/item/texture entries that are new or differ (ascending by
//                id), with an item's `commands` null exactly when it existed in `base` with the
//                same content_version. A texture entry is included exactly when it is new or any
//                field differs (textures carry no floats and no content_version-style
//                inclusion rule -- every field participates).
//   resolve()    the inverse of both: `state(seq)` from a transaction and the base it was built
//                against (ignored for a full transaction).
//
// `make_full()`/`make_patch()` copy `failures`/`unsupported`/`default_texture_filter`/
// `default_texture_repeat` verbatim from `cur` -- they are "complete, never patched" on the wire.
#ifndef GRC_RS2_DIFF_H
#define GRC_RS2_DIFF_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs2 {

Transaction make_full(const Snapshot &cur);
Transaction make_patch(const Snapshot &base, const Snapshot &cur);

// P3-SP: the same transactions with their own fields taken from `meta` instead of `cur` (and
// `base`): the version (which also picks the tables, as cur.version does above), seq, frame and,
// for a patch, base_seq. The live hub shares one published Snapshot between every connection and
// passes each connection's seq here instead of stamping a per-connection copy of it.
struct TxMeta {
  ProtocolVersion version = ProtocolVersion::V2;
  std::uint64_t seq = 0;
  std::uint64_t frame = 0;
  std::uint64_t base_seq = 0;  // patch only
};
Transaction make_full(const Snapshot &cur, const TxMeta &meta);
Transaction make_patch(const Snapshot &base, const Snapshot &cur, const TxMeta &meta);
Snapshot resolve(const Snapshot &base, const Transaction &txn);

// ------------------------------------------------------------------ resource records (/11)
//
// render-stream-11.md "Resource retention: the carried set". At /11 the resource records a stream
// sends before a target T, on a stream whose previous transaction was B, are exactly
// inline(T) \ inline(B) (inline(T) when T is the stream's first transaction): property L2, a
// function of (B, T) alone, so the host keeps no per-connection carried set and shared encodes
// share the records too.

// The host's inline decision, a function of the payload alone (L2's assumption): a name is inline
// when its payload_bytes <= inline_max_bytes. `inline_variants` decides texture variants: the
// capture never sends one inline (texture-delivery-design.md D12(c)), golden-11's recordings do.
struct InlinePolicy {
  std::uint64_t inline_max_bytes = 0;
  bool inline_variants = false;
};

// One payload a state names: its hash and payload length.
struct PayloadName {
  std::string hash;
  std::uint64_t payload_bytes = 0;
};

// names(S) in table order at each hash's first occurrence (render-stream-11.md "Definitions",
// As built rule 2): textures by id (each `ok` image's hash, then its variants in list order), then
// the static surfaces of each `ok` mesh by id (a dynamic mesh names nothing), then each `ok`
// shader whose source is `payload`, by id. Entries without a hash yet (G8kw) are skipped.
std::vector<PayloadName> payload_names(const Snapshot &state);

// inline(S): the names of `state` the host sends inline under `policy` (payload_bytes <=
// inline_max_bytes; texture variants only with `inline_variants`), in names(S)'s order.
std::vector<PayloadName> inline_names(const Snapshot &state, const InlinePolicy &policy);

// The records before `target` on a /11 stream whose previous transaction was `base` (null for the
// stream's first transaction): inline(target) \ inline(base), in table order.
std::vector<PayloadName> records_before(const Snapshot *base, const Snapshot &target,
                                        const InlinePolicy &policy);

// A stream's record planner. At /11 it is records_before() and holds nothing. With `keep_carried`
// (the W11a codec sabotage, render-stream-11.md As built rule 10) or below /11 it keeps /10's
// lifelong ever-carried set instead: a hash is recorded once per stream, so a hash that leaves the
// state and returns is never re-carried (at /11 that stream fails `resource-missing`).
class RecordPlanner {
 public:
  RecordPlanner(ProtocolVersion version, InlinePolicy policy, bool keep_carried = false)
      : lifelong_(version != ProtocolVersion::V11 || keep_carried), policy_(policy) {}

  // The records to send before `target`, given the stream's previous transaction `base` (null
  // for the first). Marks them carried when the planner is lifelong.
  std::vector<PayloadName> next(const Snapshot *base, const Snapshot &target);

  bool lifelong() const { return lifelong_; }
  std::size_t carried_count() const { return carried_.size(); }

 private:
  bool lifelong_;
  InlinePolicy policy_;
  std::vector<std::string> carried_;  // sorted; lifelong only
};

}  // namespace rs2
}  // namespace grc

#endif  // GRC_RS2_DIFF_H
