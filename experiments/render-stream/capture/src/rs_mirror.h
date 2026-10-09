// Retained canvas mirror (gate 0 WP1; render-stream/1 since gate 1 G1b2).
//
// A tap on the RenderingServer hooks that keeps the canvas state a receiver
// needs to rebuild the frame: canvases, canvas items, their parenting and
// append order, per-item state and draw commands. The frame callback copies
// it into an rs1::Snapshot (rs1_snapshot.h) under the lock and encodes it
// outside. Behaviour is specified in protocol/gate0-design.md "Q1" (root
// adoption, unknown-RID policy, viewport hooks) and "Q3" (operations, ids,
// snapshot ordering, omit-update sabotage), and in protocol/gate1-design.md
// "Q1" (root geometry), "Q2c" (draw order), "Q4" (mutation epoch) and "G1b2"
// (draw-index ties, omit-op), with the wire rules of render-stream-1.md
// ("Invariant 9", "Unsupported reasons").
//
// The mirror is engine-free: RIDs are plain uint64 values and every value is
// already in wire form (Xform/Color4/Rect4), so the unit test drives it without
// an engine. Engine RIDs never leave this module; snapshots carry wire ids.
//
// Two layers:
//   - grc::rs::Mirror, a self-contained object (one std::mutex, every method
//     thread-safe). Tests instantiate it directly.
//   - the mirror_* free functions, which act on one process-wide Mirror and
//     are what the hooks and the publisher call. The hook-side functions are
//     no-ops unless mirror_enable(true) was called, so with no stream the
//     hooks behave exactly as at gate -1.
//
// `frame` arguments are the hook stamp (hooks.cpp current_frame()): the
// 1-based main-loop iteration the call arrived in.
//
// `z_relative` and `behind` stay at their RenderingServer defaults (true,
// false): their setters are not hooked until G1e.
#ifndef GRC_RS_MIRROR_H
#define GRC_RS_MIRROR_H

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "rs1_snapshot.h"

namespace grc {
namespace rs {

// Counters that are not on the wire. Read for evidence and tests.
struct MirrorStats {
  std::uint64_t free_unknown = 0;          // free() of a RID the mirror does not know (textures, meshes, ...)
  std::uint64_t dropped_omit_update = 0;   // mutations not applied because of the omit-update sabotage
  std::uint64_t dropped_omit_op = 0;       // taps not applied because of the omit-op sabotage
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
  // session-level unsupported entries are cleared (the degenerate-host-size
  // flag included), and both sabotages (drop frame, omit-op) are reset. The
  // epoch is not reset: it advances by one, so it never repeats a value.
  void reset();

  // Binds the root viewport and root canvas RIDs from the arm-time root query
  // and sets canvas 1's transform. A zero RID binds nothing (never matches).
  void set_root(std::uint64_t viewport_rid, std::uint64_t canvas_rid, const rs1::Xform &canvas_xform);

  // Sticky capture failure `root-query-failed` with `detail` (the failed step).
  void fail_root_query(const std::string &detail);

  // Sticky capture failure `root-size-enforce-failed` with `detail`
  // (gate1-design.md Q1 "Policy": enforce-min-size could not make the host
  // size match).
  void fail_root_size_enforce(const std::string &detail);

  // While on, every snapshot's `unsupported` starts with the session-level
  // entry {op:"root_viewport_size", item:null, reason:"degenerate-host-size"}
  // (render-stream-1.md "Unsupported reasons": present exactly when
  // host_size_status != match, and the first session-level entry). Survives
  // until reset().
  void set_degenerate_host_size(bool on);

  // omit-update sabotage: mutations stamped exactly `frame` are not applied
  // (identity bookkeeping -- canvas_create, canvas_item_create, free -- always
  // is). 0 disables it.
  void set_drop_frame(std::uint64_t frame);

  // omit-op sabotage (gate1-design.md G1b2): every tap whose RenderingServer
  // method name equals `op` and whose frame is >= `from_frame` is not applied,
  // identity ops included (`free`, `canvas_item_create`, `canvas_create`).
  // An empty `op` disables it. The names are those listed on each tap below.
  void set_omit_op(const std::string &op, std::uint64_t from_frame);

  // Mutation epoch (gate1-design.md Q4 "Per-connection state"): advanced by
  // every tap call that passes the sabotage checks (not by dropped ones;
  // also not by a free() of a RID the mirror does not track, which changes
  // nothing), and by every session-level setter above. "Changed since a
  // snapshot" is one comparison of two epochs.
  std::uint64_t epoch() const;

  // --- hook taps (every one is forwarded to the engine by the caller) --------
  // The omit-op name of each tap is its RenderingServer method name: the
  // method itself for canvas_create, canvas_item_create, the viewport_* taps,
  // canvas_item_clear and canvas_item_add_rect; `free` for free_rid; and
  // canvas_item_<name> for each set_<name> tap (canvas_item_set_parent, ...,
  // canvas_item_set_material).
  void canvas_create(std::uint64_t rid, std::uint64_t frame);
  void canvas_item_create(std::uint64_t rid, std::uint64_t frame);
  void free_rid(std::uint64_t rid, std::uint64_t frame);

  void viewport_attach_canvas(std::uint64_t viewport, std::uint64_t canvas, std::uint64_t frame);
  void viewport_set_canvas_transform(std::uint64_t viewport, std::uint64_t canvas,
                                     const rs1::Xform &xform, std::uint64_t frame);

  void set_parent(std::uint64_t item, std::uint64_t parent, std::uint64_t frame);
  void set_transform(std::uint64_t item, const rs1::Xform &xform, std::uint64_t frame);
  void set_modulate(std::uint64_t item, const rs1::Color4 &color, std::uint64_t frame);
  void set_self_modulate(std::uint64_t item, const rs1::Color4 &color, std::uint64_t frame);
  void set_visible(std::uint64_t item, bool visible, std::uint64_t frame);
  void set_clip(std::uint64_t item, bool clip, std::uint64_t frame);
  void set_custom_rect(std::uint64_t item, bool enabled, const rs1::Rect4 &rect,
                       std::uint64_t frame);
  void set_visibility_layer(std::uint64_t item, std::uint32_t layer, std::uint64_t frame);
  void set_z_index(std::uint64_t item, std::int32_t z, std::uint64_t frame);
  void set_draw_index(std::uint64_t item, std::int32_t index, std::uint64_t frame);
  void set_material(std::uint64_t item, std::uint64_t material, std::uint64_t frame);

  void clear(std::uint64_t item, std::uint64_t frame);
  void add_rect(std::uint64_t item, const rs1::Rect4 &rect, const rs1::Color4 &color,
                bool antialiased, std::uint64_t frame);
  // Any other hooked canvas_item_add_*; `op` is the RenderingServer method name
  // (stored by value), which is also its omit-op name.
  void add_unsupported(std::uint64_t item, const char *op, std::uint64_t frame);

  // --- publication -----------------------------------------------------------

  // A complete copy of the current state, ordered as render-stream-0.md
  // "Transaction" and render-stream-1.md "Unsupported reasons" require:
  // session-level `unsupported` entries first (degenerate-host-size, then the
  // others in first-observed order), then item-level entries (unsupported-op
  // per distinct command name, unsupported-state for a material, and
  // draw-index-tie per render-stream-1.md "Invariant 9") by item id, then op
  // (byte order). `seq` and `frame` are copied into the snapshot.
  rs1::Snapshot snapshot(std::uint64_t seq, std::uint64_t frame) const;

  MirrorStats stats() const;

 private:
  struct Item {
    rs1::ItemState state;
    std::uint64_t rid = 0;
    // Non-null material: reported in Snapshot::unsupported only (rs1::ItemState
    // has no field for it).
    bool unsupported_state = false;
  };
  struct Canvas {
    rs1::CanvasState state;
    std::uint64_t rid = 0;
  };
  enum class Kind : std::uint8_t { Canvas, Item };
  struct Target {
    Kind kind;
    std::uint32_t id;
  };

  // All private helpers expect mutex_ held.
  // Identity taps: only omit-op applies. Advances the epoch when not dropped.
  bool dropped_identity(const char *op, std::uint64_t frame);
  // Mutation taps: omit-op, then omit-update. Advances the epoch when not dropped.
  bool dropped(const char *op, std::uint64_t frame);
  bool omit_op_matches(const char *op, std::uint64_t frame) const;
  Item *find_item(std::uint64_t rid);
  bool find_target(std::uint64_t rid, Target *out) const;
  // Looks the item up for a mutating op: unknown -> pre-existing-object,
  // an item untracked because of the cap -> silently ignored.
  Item *item_for(std::uint64_t rid, const char *op, std::uint64_t frame);
  void unknown(std::uint64_t rid, const char *op, std::uint64_t frame);
  void fail(rs1::FailureReason reason, const std::string &detail);
  void session_unsupported(const char *op, rs1::UnsupportedReason reason);
  std::vector<std::uint32_t> *children_of(rs1::ParentKind kind, std::uint32_t id);
  void detach(Item *item);
  // render-stream-1.md "Invariant 9" over one container's child list.
  void find_ties(const std::vector<std::uint32_t> &children,
                 std::vector<rs1::UnsupportedRef> *out) const;

  mutable std::mutex mutex_;
  std::uint64_t epoch_ = 0;
  std::uint64_t drop_frame_ = 0;
  std::string omit_op_;
  std::uint64_t omit_from_frame_ = 0;
  bool degenerate_host_size_ = false;
  std::uint32_t next_canvas_id_ = rs1::kRootCanvasId + 1;
  std::uint32_t next_item_id_ = 1;
  std::uint64_t root_viewport_rid_ = 0;
  std::map<std::uint32_t, Canvas> canvases_;  // ordered by id
  std::map<std::uint32_t, Item> items_;        // ordered by id
  std::unordered_map<std::uint64_t, std::uint32_t> canvas_by_rid_;
  std::unordered_map<std::uint64_t, std::uint32_t> item_by_rid_;
  std::unordered_set<std::uint64_t> untracked_items_;
  std::vector<rs1::Failure> failures_;
  std::vector<rs1::UnsupportedRef> session_unsupported_;
  MirrorStats stats_;
};

// --- process-wide mirror ------------------------------------------------------

// Turns the hook taps on or off. Enabling from disabled starts a new session
// (Mirror::reset()). Disabling keeps the state readable by mirror_snapshot().
void mirror_enable(bool enabled);
bool mirror_enabled();

void mirror_set_root(std::uint64_t viewport_rid, std::uint64_t canvas_rid, const rs1::Xform &xform);
void mirror_fail_root_query(const std::string &detail);
void mirror_fail_root_size_enforce(const std::string &detail);
void mirror_set_degenerate_host_size(bool on);
void mirror_set_drop_frame(std::uint64_t frame);
void mirror_set_omit_op(const std::string &op, std::uint64_t from_frame);
std::uint64_t mirror_epoch();
rs1::Snapshot mirror_snapshot(std::uint64_t seq, std::uint64_t frame);
MirrorStats mirror_stats();

// The process-wide Mirror, for the hook taps. Callers check mirror_enabled()
// first; the object itself does not.
Mirror &mirror_instance();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_MIRROR_H
