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

#include "rs2_snapshot.h"

namespace grc {
namespace rs2 {

Transaction make_full(const Snapshot &cur);
Transaction make_patch(const Snapshot &base, const Snapshot &cur);
Snapshot resolve(const Snapshot &base, const Transaction &txn);

}  // namespace rs2
}  // namespace grc

#endif  // GRC_RS2_DIFF_H
