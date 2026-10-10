// Retained canvas mirror (gate 0 WP1; render-stream/1 since gate 1 G1b2;
// render-stream/2 with textures since gate 2 G2b2; render-stream/3's msdf command
// since gate 4 G4e2).
//
// A tap on the RenderingServer hooks that keeps the canvas state a receiver
// needs to rebuild the frame: canvases, canvas items, their parenting and
// append order, per-item state and draw commands, and (G2b2) the texture
// table: every texture the capture saw created, with its wire id, version,
// status and the payload bytes the hook copied (gate2-design.md Q3 "Texture
// mirror"). The frame callback copies it into an rs::Captured (rs_captured.h:
// an rs2::Snapshot plus the payloads it names) under the lock and encodes it
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
// Canvas textures (gate2-design.md Q3, G2d): `canvas_texture_create` is a
// texture-table entry like any other (same id counter), kind Canvas, with its
// own diffuse/filter/repeat instead of a payload. A command naming a canvas
// texture resolves exactly like one naming an image (texture_ref): the engine
// never distinguishes them at the draw call.
//
// Texture identity follows gate2-design.md D2 exactly as the texture hook log
// (rs_resource_log.h) does, independently: one per-session id counter shared
// by images and placeholders, never reused; version 1 at creation, +1 per
// content or kind change. The checker compares the two
// (`texture-versions-current`).
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
// `z_relative` and `behind` (gate1-design.md G1e) are mutated by
// canvas_item_set_z_as_relative_to_parent and canvas_item_set_draw_behind_parent;
// a new item still starts at the RenderingServer defaults (true, false).
#ifndef GRC_RS_MIRROR_H
#define GRC_RS_MIRROR_H

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "rs2_snapshot.h"
#include "rs_captured.h"
#include "rs_resource_log.h"

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
  // Gate 2 (G2b2).
  std::uint64_t live_textures = 0;           // table entries, tombstones included
  std::uint64_t texture_update_unknown = 0;  // texture_2d_update of a RID never seen created
  std::uint64_t texture_payload_bytes = 0;   // distinct payload bytes the table holds now
};

class Mirror {
 public:
  Mirror();

  // Forgets everything and starts a new session: canvas 1 (the root, origin
  // root-query, attached) exists with no RIDs bound, ids restart, failures and
  // session-level unsupported entries are cleared (the degenerate-host-size
  // flag included), and the sabotages (drop frame, omit-op, perturb-glyph) are reset. The
  // epoch is not reset: it advances by one, so it never repeats a value.
  void reset();

  // Binds the root viewport and root canvas RIDs from the arm-time root query
  // and sets canvas 1's transform. A zero RID binds nothing (never matches).
  void set_root(std::uint64_t viewport_rid, std::uint64_t canvas_rid, const rs2::Xform &canvas_xform);

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

  // A headless host (G2d; protocol/canvas-texture-headless.md): the dummy storage's
  // canvas_texture_allocate() returns RID() (servers/rendering/dummy/storage/texture_storage.h:54),
  // so a CanvasTexture's draws name RID(). While on, a texture-rect draw naming RID() becomes an
  // `unsupported` command with reason `canvas-texture-headless` instead of `tex: null` (which would
  // replay as the engine's white default texture). Survives until reset().
  void set_canvas_texture_headless(bool on);

  // omit-update sabotage: mutations stamped exactly `frame` are not applied
  // (identity bookkeeping -- canvas_create, canvas_item_create, free -- always
  // is). 0 disables it.
  void set_drop_frame(std::uint64_t frame);

  // omit-op sabotage (gate1-design.md G1b2): every tap whose RenderingServer
  // method name equals `op` and whose frame is >= `from_frame` is not applied,
  // identity ops included (`free`, `canvas_item_create`, `canvas_create`).
  // An empty `op` disables it. The names are those listed on each tap below.
  void set_omit_op(const std::string &op, std::uint64_t from_frame);

  // perturb-glyph sabotage (gate4-design.md Q3, render-stream-3.md "Sabotage"): from
  // `from_frame` on, every add_texture_rect_region and add_msdf_texture_rect_region the mirror
  // records gets +0.25 on rect.x; the engine still gets the true arguments. 0 disables it.
  void set_perturb_glyph(std::uint64_t from_frame);

  // Mutation epoch (gate1-design.md Q4 "Per-connection state"): advanced by
  // every tap call that passes the sabotage checks (not by dropped ones;
  // also not by a free() of a RID the mirror does not track, which changes
  // nothing), and by every session-level setter above. "Changed since a
  // snapshot" is one comparison of two epochs.
  std::uint64_t epoch() const;

  // --- hook taps (every one is forwarded to the engine by the caller) --------
  // The omit-op name of each tap is its RenderingServer method name: the
  // method itself for canvas_create, canvas_item_create, the viewport_* taps,
  // canvas_item_clear, canvas_item_add_rect, the texture taps
  // (texture_2d_create, texture_2d_update, texture_replace, ...) and the
  // texture-rect draws; `free` for free_rid; and
  // canvas_item_<name> for each set_<name> tap (canvas_item_set_parent, ...,
  // canvas_item_set_material, canvas_item_set_z_as_relative_to_parent,
  // canvas_item_set_draw_behind_parent).
  void canvas_create(std::uint64_t rid, std::uint64_t frame);
  void canvas_item_create(std::uint64_t rid, std::uint64_t frame);
  void free_rid(std::uint64_t rid, std::uint64_t frame);

  void viewport_attach_canvas(std::uint64_t viewport, std::uint64_t canvas, std::uint64_t frame);
  void viewport_set_canvas_transform(std::uint64_t viewport, std::uint64_t canvas,
                                     const rs2::Xform &xform, std::uint64_t frame);

  void set_parent(std::uint64_t item, std::uint64_t parent, std::uint64_t frame);
  void set_transform(std::uint64_t item, const rs2::Xform &xform, std::uint64_t frame);
  void set_modulate(std::uint64_t item, const rs2::Color4 &color, std::uint64_t frame);
  void set_self_modulate(std::uint64_t item, const rs2::Color4 &color, std::uint64_t frame);
  void set_visible(std::uint64_t item, bool visible, std::uint64_t frame);
  void set_clip(std::uint64_t item, bool clip, std::uint64_t frame);
  void set_custom_rect(std::uint64_t item, bool enabled, const rs2::Rect4 &rect,
                       std::uint64_t frame);
  void set_visibility_layer(std::uint64_t item, std::uint32_t layer, std::uint64_t frame);
  void set_z_index(std::uint64_t item, std::int32_t z, std::uint64_t frame);
  void set_draw_index(std::uint64_t item, std::int32_t index, std::uint64_t frame);
  // gate1-design.md G1e: canvas_item_set_z_as_relative_to_parent / _draw_behind_parent.
  void set_z_relative(std::uint64_t item, bool relative, std::uint64_t frame);
  void set_behind(std::uint64_t item, bool behind, std::uint64_t frame);
  void set_material(std::uint64_t item, std::uint64_t material, std::uint64_t frame);
  // canvas_item_attach_skeleton (gate5-design.md D2, D16, calibrator 7): a non-null skeleton is
  // reported in Snapshot::unsupported only, as a non-null material is -- its own op name,
  // {"op":"canvas_item_attach_skeleton","reason":"unsupported-state"} -- never content_version.
  void attach_skeleton(std::uint64_t item, std::uint64_t skeleton, std::uint64_t frame);

  // canvas_item_clear: empties the commands, bumps content_version and resets
  // `clip` to false, as the engine's Item::clear() does (gate3-design.md D3);
  // `custom_rect` is kept.
  void clear(std::uint64_t item, std::uint64_t frame);
  void add_rect(std::uint64_t item, const rs2::Rect4 &rect, const rs2::Color4 &color,
                bool antialiased, std::uint64_t frame);
  // Any other hooked canvas_item_add_*; `op` is the RenderingServer method name
  // (stored by value), which is also its omit-op name.
  void add_unsupported(std::uint64_t item, const char *op, std::uint64_t frame);

  // --- textures (gate 2, G2b2; gate2-design.md Q3 "Texture mirror") ----------
  //
  // canvas_item_add_texture_rect(_region): `texture` is the engine RID the
  // command names. A RID the mirror knows becomes its wire id; RID() becomes
  // `tex: null` (the engine's default white texture), or on a headless host
  // (set_canvas_texture_headless) an `unsupported` command with reason
  // `canvas-texture-headless`; any other RID becomes an
  // `unsupported` command with reason `unknown-texture` (render-stream-2.md
  // "Commands"). Both bump content_version like add_rect.
  void add_texture_rect(std::uint64_t item, const rs2::Rect4 &rect, std::uint64_t texture,
                        bool tile, const rs2::Color4 &modulate, bool transpose,
                        std::uint64_t frame);
  void add_texture_rect_region(std::uint64_t item, const rs2::Rect4 &rect, std::uint64_t texture,
                               const rs2::Rect4 &src, const rs2::Color4 &modulate,
                               bool transpose, bool clip_uv, std::uint64_t frame);
  // canvas_item_add_msdf_texture_rect_region (G4e2; gate4-design.md Q3 "MSDF tap",
  // render-stream-3.md "Command"): the /3 command with the engine's int outline_size, px_range
  // and scale; the same texture, unknown-texture, canvas-texture-headless, omit-op and
  // pre-existing-object rules as add_texture_rect_region.
  void add_msdf_texture_rect_region(std::uint64_t item, const rs2::Rect4 &rect,
                                    std::uint64_t texture, const rs2::Rect4 &src,
                                    const rs2::Color4 &modulate, std::int32_t outline_size,
                                    float px_range, float scale, std::uint64_t frame);

  // canvas_item_set_default_texture_filter / _repeat: the item's own fields
  // (RenderingServer enums; an out-of-range value is ignored, as the server's
  // ERR_FAIL_INDEX does). They change the item entry, not content_version.
  void set_texture_filter(std::uint64_t item, std::int32_t filter, std::uint64_t frame);
  void set_texture_repeat(std::uint64_t item, std::int32_t repeat, std::uint64_t frame);

  // The root viewport's default texture filter and repeat, read at arm
  // through the Viewport binds (gate2-design.md Q1d), as RenderingServer
  // enums. Never `default` (the server refuses it).
  void set_texture_defaults(rs2::Filter filter, rs2::Repeat repeat);
  // viewport_set_default_canvas_item_texture_filter / _repeat: on the root
  // viewport, the transaction scalars; on any other viewport, the session-level
  // `non-root-viewport` entry (gate 0's rule). DEFAULT and out-of-range values
  // are ignored, as renderer_viewport.cpp:1541-1554 refuses them.
  void viewport_set_texture_filter(std::uint64_t viewport, std::int32_t filter,
                                   std::uint64_t frame);
  void viewport_set_texture_repeat(std::uint64_t viewport, std::int32_t repeat,
                                   std::uint64_t frame);

  // texture_2d_create: a new id, kind image, version 1, status from the copy
  // (`bytes` is the GRT1 payload when copy.status is "ok", null otherwise).
  void texture_2d_create(std::uint64_t rid, const PayloadCopy &copy, PayloadPtr bytes,
                         std::uint64_t frame);
  // texture_2d_placeholder_create: a new id, kind placeholder, version 1.
  void texture_2d_placeholder_create(std::uint64_t rid, std::uint64_t frame);
  // texture_2d_update: a known id gets version + 1 and, when the layer is 0 and
  // the shape equals the texture's, the new payload; otherwise it becomes
  // `unsupported` (`layered-update`, `update-shape-mismatch`). An unknown RID is
  // counted (texture_update_unknown) and changes nothing.
  void texture_2d_update(std::uint64_t rid, const PayloadCopy &copy, PayloadPtr bytes, int layer,
                         std::uint64_t frame);
  // texture_replace(t, b): t takes b's kind, status, reason and payload at
  // version + 1, and b's id leaves the table (the storage frees b itself, with
  // no free call). b unknown: t becomes `unsupported` (`unknown-texture`). t
  // unknown: b's id leaves the table. t == b: nothing.
  void texture_replace(std::uint64_t texture, std::uint64_t by_texture, std::uint64_t frame);

  // spurious-texture-update sabotage (gate2-design.md G2b2): bumps the version of
  // the lowest-id `ok` image and re-copies its identical bytes. Returns that
  // texture's RID (0 when there is none) so the caller can write the matching
  // hook-log line.
  std::uint64_t spurious_texture_update(std::uint64_t frame);

  // --- canvas textures (gate 2, G2d; gate2-design.md Q3 "Texture mirror") ---
  //
  // canvas_texture_create: a new id, kind canvas, status ok, version 1,
  // {diffuse: null, filter: default, repeat: default} (identity tap: only
  // omit-op applies).
  void canvas_texture_create(std::uint64_t rid, std::uint64_t frame);
  // canvas_texture_set_channel: channel 0 (DIFFUSE) sets/clears `diffuse` to the
  // wire id of a known RID, null for RID(), or an unresolvable non-null RID
  // (reason unknown-texture, D10). Channel 1 (NORMAL) or 2 (SPECULAR) only ever
  // records whether it is non-null: set makes the entry `unsupported`
  // (canvas-texture-channel); clearing both back to null makes it `ok` again.
  // Any other channel value is ignored, as the server's ERR_FAIL_INDEX is.
  // version + 1 only when something actually changed.
  void canvas_texture_set_channel(std::uint64_t canvas_texture, std::int32_t channel,
                                  std::uint64_t texture, std::uint64_t frame);
  // canvas_texture_set_texture_filter / _repeat: the canvas texture's own
  // filter/repeat (RenderingServer enums; out of range is ignored). version + 1
  // only on an actual change.
  void canvas_texture_set_filter(std::uint64_t canvas_texture, std::int32_t filter,
                                 std::uint64_t frame);
  void canvas_texture_set_repeat(std::uint64_t canvas_texture, std::int32_t repeat,
                                 std::uint64_t frame);

  // True when the omit-op sabotage drops `op` at `frame` (the hooks also leave
  // such a texture call out of the hook log's registry; rs_resource_log.h).
  bool omits(const char *op, std::uint64_t frame) const;

  // --- publication -----------------------------------------------------------

  // A complete copy of the current state, ordered as render-stream-0.md
  // "Transaction" and render-stream-1.md "Unsupported reasons" require:
  // session-level `unsupported` entries first (degenerate-host-size, then the
  // others in first-observed order), then item-level entries (unsupported-op
  // per distinct command name, unsupported-state for a material, and
  // draw-index-tie per render-stream-1.md "Invariant 9") by item id, then op
  // (byte order). `seq` and `frame` are copied into the snapshot.
  //
  // Since G2b2 the copy also holds the texture table (sorted by id; a `freed`
  // tombstone that no command names any more leaves the table here, at the
  // first snapshot in which nothing names it), the derived item-level
  // `unknown-texture` / `unsupported-texture` entries (render-stream-2.md
  // "Item-level unsupported entries"), the root's default filter and repeat,
  // and the payload of every `ok` image entry.
  Captured snapshot(std::uint64_t seq, std::uint64_t frame);

  MirrorStats stats() const;

 private:
  struct Item {
    rs2::ItemState state;
    std::uint64_t rid = 0;
    // Non-null material: reported in Snapshot::unsupported only (rs2::ItemState
    // has no field for it).
    bool unsupported_state = false;
    // Non-null skeleton (gate5-design.md D2, calibrator 7): same idea, its own op name.
    bool unsupported_skeleton = false;
  };
  struct Canvas {
    rs2::CanvasState state;
    std::uint64_t rid = 0;
  };
  struct Texture {
    std::uint32_t id = 0;
    std::uint64_t rid = 0;  // 0 once freed (a tombstone) or retired
    rs2::TextureKind kind = rs2::TextureKind::Image;
    rs2::TextureStatus status = rs2::TextureStatus::Ok;
    bool has_reason = false;
    rs2::TextureReason reason = rs2::TextureReason::UnsupportedFormat;
    std::uint64_t version = 1;
    // The last accepted copy's description (kind image): its shape decides
    // whether an update is accepted, as in the hook log.
    PayloadCopy copy;
    PayloadPtr bytes;  // the payload while status is ok and kind image
    // Canvas fields (kind == Canvas only; gate2-design.md Q3, G2d).
    bool has_diffuse = false;
    std::uint32_t diffuse_id = 0;
    // A non-null diffuse RID the mirror never saw created (unknown-texture);
    // `has_diffuse` is false in that case too (nothing to name on the wire).
    bool diffuse_unknown = false;
    bool normal_set = false;    // a non-null normal channel is set
    bool specular_set = false;  // a non-null specular channel is set
    rs2::Filter filter = rs2::Filter::Default;
    rs2::Repeat repeat = rs2::Repeat::Default;
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
  void fail(rs2::FailureReason reason, const std::string &detail);
  void session_unsupported(const char *op, rs2::UnsupportedReason reason);
  std::vector<std::uint32_t> *children_of(rs2::ParentKind kind, std::uint32_t id);
  void detach(Item *item);
  // Appends one command (cap checked) and bumps content_version.
  void push_command(Item *item, rs2::Command command, std::uint64_t frame);
  // `rect` with perturb-glyph applied when it is active at `frame`.
  rs2::Rect4 perturbed_glyph(const rs2::Rect4 &rect, std::uint64_t frame) const;
  // A texture argument as a command: tex id / null, or false for an unknown RID.
  bool texture_ref(std::uint64_t rid, bool *has_tex, std::uint32_t *tex) const;
  Texture *find_texture(std::uint64_t rid);
  bool texture_referenced(std::uint32_t id) const;
  // Takes `id` out of the table: a `freed` tombstone while a command names it,
  // gone otherwise.
  void retire_texture(std::uint32_t id);
  static rs2::TextureEntry wire_entry(const Texture &texture);
  // render-stream-1.md "Invariant 9" over one container's child list.
  void find_ties(const std::vector<std::uint32_t> &children,
                 std::vector<rs2::UnsupportedRef> *out) const;

  mutable std::mutex mutex_;
  std::uint64_t epoch_ = 0;
  std::uint64_t drop_frame_ = 0;
  std::string omit_op_;
  std::uint64_t omit_from_frame_ = 0;
  std::uint64_t perturb_glyph_frame_ = 0;
  bool degenerate_host_size_ = false;
  bool canvas_texture_headless_ = false;
  std::uint32_t next_canvas_id_ = rs2::kRootCanvasId + 1;
  std::uint32_t next_item_id_ = 1;
  std::uint64_t root_viewport_rid_ = 0;
  std::map<std::uint32_t, Canvas> canvases_;  // ordered by id
  std::map<std::uint32_t, Item> items_;        // ordered by id
  std::map<std::uint32_t, Texture> textures_;  // ordered by id, tombstones included
  std::unordered_map<std::uint64_t, std::uint32_t> texture_by_rid_;
  std::uint32_t next_texture_id_ = 1;
  rs2::Filter default_filter_ = rs2::Filter::Linear;   // the server's initial values
  rs2::Repeat default_repeat_ = rs2::Repeat::Disabled;  // (renderer_viewport.h:114-115)
  std::unordered_map<std::uint64_t, std::uint32_t> canvas_by_rid_;
  std::unordered_map<std::uint64_t, std::uint32_t> item_by_rid_;
  std::unordered_set<std::uint64_t> untracked_items_;
  std::vector<rs2::Failure> failures_;
  std::vector<rs2::UnsupportedRef> session_unsupported_;
  MirrorStats stats_;
};

// --- process-wide mirror ------------------------------------------------------

// Turns the hook taps on or off. Enabling from disabled starts a new session
// (Mirror::reset()). Disabling keeps the state readable by mirror_snapshot().
void mirror_enable(bool enabled);
bool mirror_enabled();

void mirror_set_root(std::uint64_t viewport_rid, std::uint64_t canvas_rid, const rs2::Xform &xform);
void mirror_fail_root_query(const std::string &detail);
void mirror_fail_root_size_enforce(const std::string &detail);
void mirror_set_degenerate_host_size(bool on);
void mirror_set_canvas_texture_headless(bool on);
void mirror_set_drop_frame(std::uint64_t frame);
void mirror_set_omit_op(const std::string &op, std::uint64_t from_frame);
void mirror_set_perturb_glyph(std::uint64_t from_frame);
std::uint64_t mirror_epoch();
Captured mirror_snapshot(std::uint64_t seq, std::uint64_t frame);
MirrorStats mirror_stats();

// The process-wide Mirror, for the hook taps. Callers check mirror_enabled()
// first; the object itself does not.
Mirror &mirror_instance();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_MIRROR_H
