// render-stream/1 patch diff and resolution: deriving a wire-level Transaction from one or two
// Snapshots, and the inverse.
//
// Pure: no I/O, no engine or GDExtension types. render-stream-1.md "Patch transactions" and
// "Resolution" specify the rules these three functions implement:
//   make_full()  a full transaction: every canvas/item present, commands never null.
//   make_patch() a patch transaction against `base`: removed_* for ids gone from `cur`, and
//                exactly the canvas/item entries that are new or differ (ascending by id), with
//                an item's `commands` null exactly when it existed in `base` with the same
//                content_version.
//   resolve()    the inverse of both: `state(seq)` from a transaction and the base it was built
//                against (ignored for a full transaction).
//
// `make_full()`/`make_patch()` copy `failures`/`unsupported` verbatim from `cur` -- they are
// "complete, never patched" on the wire, and (in production, from G1b2) computed by the mirror,
// not derived here. Draw-index-tie detection in particular is a mirror responsibility
// (gate1-design.md G1b2); this file never recomputes it.
#ifndef GRC_RS1_DIFF_H
#define GRC_RS1_DIFF_H

#include "rs1_snapshot.h"

namespace grc {
namespace rs1 {

// A full transaction copied from `cur`: encoding=Full, base_seq unset, removed_* empty, every
// canvas/item present with its full commands.
Transaction make_full(const Snapshot &cur);

// A patch transaction from `base` to `cur`: encoding=Patch, base_seq=base.seq. The caller is
// responsible for the delivery-level invariant that `base` is the receiver's last acknowledged,
// applied snapshot (gate1-design.md D2); this function only computes the diff.
Transaction make_patch(const Snapshot &base, const Snapshot &cur);

// The resolved state named by `txn`, against `base` (ignored when `txn.encoding` is Full). A
// patch's null-commands items take their commands from `base`'s entry of the same id.
// Mirrors scripts/lib/render-stream-1.ts's resolveRecording() and receiver/rs1_decoder.gd's
// Stream, for the round-trip property rs1_diff_test.cpp checks: resolving a chain of patches
// built with make_patch() reproduces the same full states make_full() would have encoded.
Snapshot resolve(const Snapshot &base, const Transaction &txn);

}  // namespace rs1
}  // namespace grc

#endif  // GRC_RS1_DIFF_H
