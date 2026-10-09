// render-stream/0 retained canvas mirror (gate 0, WP1).
//
// A tap on the RenderingServer hooks that keeps the canvas state a receiver
// needs to rebuild the frame: canvases, canvas items, their parenting and
// append order, per-item state and draw commands. The frame callback copies
// it into an rs0::Snapshot (rs0_snapshot.h) under the lock and encodes it
// outside. Behaviour is specified in protocol/gate0-design.md "Q1" (root
// adoption, unknown-RID policy, viewport hooks) and "Q3" (operations, ids,
// snapshot ordering, omit-update sabotage).
//
// The mirror is engine-free: RIDs are plain uint64 values and every value is
// already in wire form (Xform/Color4/Rect4), so the unit test drives it without
// an engine. Engine RIDs never leave this module; snapshots carry wire ids.
//
// Two layers:
//   - grc::rs0::Mirror, a self-contained object (one std::mutex, every method
//     thread-safe). Tests instantiate it directly.
//   - the mirror_* free functions, which act on one process-wide Mirror and
//     are what the hooks and the publisher call. The hook-side functions are
//     no-ops unless mirror_enable(true) was called, so with no stream the
//     hooks behave exactly as at gate -1.
//
// `frame` arguments are the hook stamp (hooks.cpp current_frame()): the
// 1-based main-loop iteration the call arrived in.
#ifndef GRC_RS0_MIRROR_H
#define GRC_RS0_MIRROR_H

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "rs0_snapshot.h"

namespace grc {
namespace rs0 {

// Counters that are not on the wire. Read for evidence and tests.
struct MirrorStats {
  std::uint64_t free_unknown = 0;          // free() of a RID the mirror does not know (textures, meshes, ...)
  std::uint64_t dropped_omit_update = 0;   // mutations not applied because of the omit-update sabotage
  std::uint64_t dropped_capacity = 0;      // creates/commands not applied because a cap was hit
  std::uint64_t ignored_untracked = 0;     // calls on an item that was not tracked because of the cap
  std::uint64_t live_canvases = 0;         // root canvas included
  std::uint64_t live_items = 0;
};

class Mirror {
 public:
  Mirror();

  // Forgets everything and starts a new session: canvas 1 (the root, origin
  // root-query, attached) exists with no RIDs bound, ids restart, failures and
  // session-level unsupported entries are cleared, the drop frame is reset.
  void reset();

  // Binds the root viewport and root canvas RIDs from the arm-time root query
  // and sets canvas 1's transform. A zero RID binds nothing (never matches).
  void set_root(std::uint64_t viewport_rid, std::uint64_t canvas_rid, const Xform &canvas_xform);

  // Sticky capture failure `root-query-failed` with `detail` (the failed step).
  void fail_root_query(const std::string &detail);

  // omit-update sabotage: mutations stamped exactly `frame` are not applied
  // (identity bookkeeping -- canvas_create, canvas_item_create, free -- always
  // is). 0 disables it.
  void set_drop_frame(std::uint64_t frame);

  // --- hook taps (every one is forwarded to the engine by the caller) --------
  void canvas_create(std::uint64_t rid, std::uint64_t frame);
  void canvas_item_create(std::uint64_t rid, std::uint64_t frame);
  void free_rid(std::uint64_t rid, std::uint64_t frame);

  void viewport_attach_canvas(std::uint64_t viewport, std::uint64_t canvas, std::uint64_t frame);
  void viewport_set_canvas_transform(std::uint64_t viewport, std::uint64_t canvas,
                                     const Xform &xform, std::uint64_t frame);

  void set_parent(std::uint64_t item, std::uint64_t parent, std::uint64_t frame);
  void set_transform(std::uint64_t item, const Xform &xform, std::uint64_t frame);
  void set_modulate(std::uint64_t item, const Color4 &color, std::uint64_t frame);
  void set_self_modulate(std::uint64_t item, const Color4 &color, std::uint64_t frame);
  void set_visible(std::uint64_t item, bool visible, std::uint64_t frame);
  void set_clip(std::uint64_t item, bool clip, std::uint64_t frame);
  void set_custom_rect(std::uint64_t item, bool enabled, const Rect4 &rect, std::uint64_t frame);
  void set_visibility_layer(std::uint64_t item, std::uint32_t layer, std::uint64_t frame);
  void set_z_index(std::uint64_t item, std::int32_t z, std::uint64_t frame);
  void set_draw_index(std::uint64_t item, std::int32_t index, std::uint64_t frame);
  void set_material(std::uint64_t item, std::uint64_t material, std::uint64_t frame);

  void clear(std::uint64_t item, std::uint64_t frame);
  void add_rect(std::uint64_t item, const Rect4 &rect, const Color4 &color, bool antialiased,
                std::uint64_t frame);
  // Any other hooked canvas_item_add_*; `op` is the RenderingServer method name
  // (a string literal: it is stored by value).
  void add_unsupported(std::uint64_t item, const char *op, std::uint64_t frame);

  // --- publication -----------------------------------------------------------

  // A complete copy of the current state, ordered as render-stream-0.md
  // "Transaction" requires. `seq` and `frame` are copied into the snapshot.
  Snapshot snapshot(std::uint64_t seq, std::uint64_t frame) const;

  MirrorStats stats() const;

 private:
  struct Item {
    ItemState state;
    std::uint64_t rid = 0;
  };
  struct Canvas {
    CanvasState state;
    std::uint64_t rid = 0;
  };
  enum class Kind : std::uint8_t { Canvas, Item };
  struct Target {
    Kind kind;
    std::uint32_t id;
  };

  // All private helpers expect mutex_ held.
  bool dropped(std::uint64_t frame);
  Item *find_item(std::uint64_t rid);
  bool find_target(std::uint64_t rid, Target *out) const;
  // Looks the item up for a mutating op: unknown -> pre-existing-object,
  // an item untracked because of the cap -> silently ignored.
  Item *item_for(std::uint64_t rid, const char *op, std::uint64_t frame);
  void unknown(std::uint64_t rid, const char *op, std::uint64_t frame);
  void fail(FailureReason reason, const std::string &detail);
  void session_unsupported(const char *op, UnsupportedReason reason);
  std::vector<std::uint32_t> *children_of(ParentKind kind, std::uint32_t id);
  void detach(Item *item);

  mutable std::mutex mutex_;
  std::uint64_t drop_frame_ = 0;
  std::uint32_t next_canvas_id_ = kRootCanvasId + 1;
  std::uint32_t next_item_id_ = 1;
  std::uint64_t root_viewport_rid_ = 0;
  std::map<std::uint32_t, Canvas> canvases_;  // ordered by id
  std::map<std::uint32_t, Item> items_;        // ordered by id
  std::unordered_map<std::uint64_t, std::uint32_t> canvas_by_rid_;
  std::unordered_map<std::uint64_t, std::uint32_t> item_by_rid_;
  std::unordered_set<std::uint64_t> untracked_items_;
  std::vector<Failure> failures_;
  std::vector<UnsupportedRef> session_unsupported_;
  MirrorStats stats_;
};

// --- process-wide mirror ------------------------------------------------------

// Turns the hook taps on or off. Enabling from disabled starts a new session
// (Mirror::reset()). Disabling keeps the state readable by mirror_snapshot().
void mirror_enable(bool enabled);
bool mirror_enabled();

void mirror_set_root(std::uint64_t viewport_rid, std::uint64_t canvas_rid, const Xform &xform);
void mirror_fail_root_query(const std::string &detail);
void mirror_set_drop_frame(std::uint64_t frame);
Snapshot mirror_snapshot(std::uint64_t seq, std::uint64_t frame);
MirrorStats mirror_stats();

// The process-wide Mirror, for the hook taps. Callers check mirror_enabled()
// first; the object itself does not.
Mirror &mirror_instance();

}  // namespace rs0
}  // namespace grc

#endif  // GRC_RS0_MIRROR_H
