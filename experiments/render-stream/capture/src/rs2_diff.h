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
  // PM1 sabotage perturb-instance (render-stream-11.md "As built (PM1)" rule 11), /11 only.
  bool perturb_instance = false;
  // PM5 sabotage perturb-seed (render-stream-12.md "Sabotages"), /12 only.
  bool perturb_seed = false;
};
Transaction make_full(const Snapshot &cur, const TxMeta &meta);
Transaction make_patch(const Snapshot &base, const Snapshot &cur, const TxMeta &meta);
Snapshot resolve(const Snapshot &base, const Transaction &txn);

// ------------------------------------------------------------------ multimesh (/11, PM1)
//
// render-stream-11.md "As built (PM1): decisions". A /11 transaction carries the multimesh table
// (make_full: every entry, every `ok` buffer; make_patch: rule 9's membership and rule 3's
// buffer_f, decided from the entries' buffer serials, a function of (B, T) alone). Below /11 a
// snapshot that holds multimesh commands is first lowered: make_full()/make_patch() call
// lower_multimesh() on it themselves, so a /10 connection of a /11 host sees exactly what it saw
// before PM1 (rule 7: "Below /11 ... the command is /10's unsupported/unsupported-op").

// The command list as below /11: every add_multimesh, and every `unsupported` command named
// canvas_item_add_multimesh (unknown-multimesh, unknown-texture, ...), becomes
// {"op":"unsupported","name":"canvas_item_add_multimesh","reason":"unsupported-op"}. Returns
// false (and leaves `out` untouched) when the list holds no such command.
bool lower_multimesh_commands(const std::vector<Command> &commands, std::vector<Command> *out);

// `state` as a connection below /11 sees it: no multimesh table, every item's commands lowered
// (its content_version_below_v11 substituted where set), and the item-level entries of
// canvas_item_add_multimesh replaced by one `unsupported-op` entry per item drawing one, in the
// mirror's order (item id, then op, then reason). A state without multimesh commands is returned
// unchanged.
Snapshot lower_multimesh(const Snapshot &state);

// Rule 8: features.ops gains "add_multimesh", features.resources "multimesh", and
// features.observed_unsupported_ops loses "canvas_item_add_multimesh" (each list stays sorted).
// unobserve_multimesh_features() is the inverse, for a /10 connection of a /11 host. Both are
// idempotent.
void observe_multimesh_features(Features *features);
void unobserve_multimesh_features(Features *features);

// ------------------------------------------------------------------ particles (/12, PM5)
//
// render-stream-12.md. A /12 transaction carries the particles table (make_full: every entry and
// the emits of the target's own frame; make_patch: the entries new or differing since the base,
// removed_particles, and the emits of host frames (B, T] its emit tail still holds). Below /12 a
// snapshot that holds particles commands (or /12-only shader/material forms) is first lowered:
// make_full()/make_patch() call lower_particles() on it themselves.

// The command list as /11 sees it: every add_particles, and every `unsupported` command named
// canvas_item_add_particles, becomes /11's
// {"op":"unsupported","name":"canvas_item_add_particles","reason":"unsupported-op"}. Returns false
// (and leaves `out` untouched) when the list holds no such command.
bool lower_particles_commands(const std::vector<Command> &commands, std::vector<Command> *out);

// The command list as below /11 sees it: particles and multimesh commands lowered (the list a
// /10 connection of a /12 host sees). Returns false when nothing lowers.
bool lower_v11_commands(const std::vector<Command> &commands, std::vector<Command> *out);

// `state` as a /11 connection sees it: no particles table and no emits, every item's commands
// lowered (its content_version_below_v12 substituted where set), each shader and material
// replaced by its below_v12 form where set, and the item-level entries of
// canvas_item_add_particles replaced by one `unsupported-op` entry per item drawing one.
Snapshot lower_particles(const Snapshot &state);

// features.ops gains "add_particles", features.resources "particles", and
// features.observed_unsupported_ops loses "canvas_item_add_particles" (each list stays sorted);
// unobserve_particles_features() is the inverse, for a connection below /12 of a /12 host.
void observe_particles_features(Features *features);
void unobserve_particles_features(Features *features);

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
      : lifelong_(!is_v11_or_later(version) || keep_carried), policy_(policy) {}

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
