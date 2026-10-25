// Retained canvas mirror (gate 0 WP1; render-stream/1 since gate 1 G1b2;
// render-stream/2 with textures since gate 2 G2b2; render-stream/3's msdf command
// since gate 4 G4e2; render-stream/4's immediate geometry, add_set_transform and
// add_clip_ignore since gate 5 G5d -- every snapshot is stamped ProtocolVersion::V4 --
// render-stream/4's mesh table and add_mesh since G5e; render-stream/5 since G55d: every
// snapshot is stamped V5 and carries the shader and material tables, the item material fields and
// the canvas modulate; render-stream/6 since G6b: every snapshot is stamped V6, canvases carry
// `layer`/`sublayer`, extra canvases attached to the root viewport are supported, and the five
// /6 session-level reasons are emitted).
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
//
// Unknown RIDs (protocol/unknown-item-skip.md): under the default policy (Strict) a canvas or
// item RID the mirror never saw created is gate 0's sticky `pre-existing-object` failure. Under
// Skip (GRC_UNKNOWN_ITEM=skip) the call is counted and not applied, the RID is remembered as
// unknown until it is freed, and every known item whose parent chain reaches an unknown RID is
// kept (its state and commands are still recorded) but withheld from every snapshot. An item
// that enters a withheld subtree after it was published gets a fresh wire id first, so a later
// return to publication is a new id, never a reappearing one (render-stream-0.md `id-reused`).
#ifndef GRC_RS_MIRROR_H
#define GRC_RS_MIRROR_H

#include <array>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "rs2_snapshot.h"
#include "rs_captured.h"
#include "rs_resource_log.h"
#include "rs_texture_delivery.h"
#include "rs_variant.h"

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
  // Gate 5 (G5e).
  std::uint64_t live_meshes = 0;          // mesh-table entries, tombstones included
  std::uint64_t mesh_unknown = 0;         // a mesh tap naming a RID the table does not know
  std::uint64_t mesh_payload_bytes = 0;   // distinct GRM1 payload bytes the table holds now
  // Gate 5.5 (G55d).
  std::uint64_t live_shaders = 0;
  std::uint64_t live_materials = 0;
  std::uint64_t shader_payload_bytes = 0;  // distinct GRP1 payload bytes the table holds now
  std::uint64_t material_unknown = 0;      // a shader/material tap naming a RID the table lacks
  // protocol/unknown-item-skip.md (Skip only; all zero under Strict).
  std::uint64_t unknown_calls = 0;       // hook calls that named an unknown canvas/item RID
  std::uint64_t unknown_rids_named = 0;  // distinct unknown RIDs ever named (freed ones included)
  std::uint64_t unknown_rids = 0;        // unknown RIDs named and not freed, now
  std::uint64_t withheld_items = 0;      // known items withheld from publication, now
  std::uint64_t rekeyed_items = 0;       // published items given a fresh id on entering a withheld subtree
};

// What a mesh hook hands the mirror for one surface (G5e; gate5-design.md Q3a, Q3b): the hook
// log's description of it (rs_resource_log.h: status, reason, primitive, format, counts, hash)
// and, when its status is "ok", the render-stream-mesh/1 payload the hook encoded from the whole
// SurfaceData (or, after a region update, from its own retained buffers with the update applied).
struct MeshSurfaceInput {
  MeshSurfaceCopy copy;
  PayloadPtr bytes;
};

// What a shader-code hook hands the mirror (G55d; gate5_5-design.md Q3a, Q3b): the hook log's
// classification of the code (rs_resource_log.h ShaderCopy: status, reason, mode, uses, builtin,
// hash, payload_bytes) and, whenever the hook built one (copy.hash non-empty), the whole GRP1
// payload, shared like a texture's.
struct ShaderCodeInput {
  ShaderCopy copy;
  PayloadPtr bytes;
};

class Mirror {
 public:
  Mirror();

  // Forgets everything and starts a new session: canvas 1 (the root, origin
  // root-query, attached) exists with no RIDs bound, ids restart, failures and
  // session-level unsupported entries are cleared (the degenerate-host-size
  // flag included), and the sabotages (drop frame, omit-op, perturb-glyph, perturb-vertex) and
  // the canvas-texture-created flag (D11) are reset. The
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

  // protocol/unknown-item-skip.md: Strict (the reset() default) or Skip. Set once at arm, before
  // the first hook call is expected; survives until reset(). Under Skip every snapshot carries
  // Snapshot::unknown_items (present, zeros included).
  void set_unknown_item_policy(rs2::UnknownItemPolicy policy);

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

  // G8a (gate8-design.md D3-D5): the arm-time adoption walk's entry points. Each registers an
  // object that already existed when the capture armed, exactly as canvas_create /
  // canvas_item_create would, but with origin `adopted`; its state then arrives through the same
  // setters the hooks call (rs_adopt.cpp), so adoption declares exactly what the hooks would have.
  void adopt_canvas(std::uint64_t rid, std::uint64_t frame);
  void adopt_item(std::uint64_t rid, std::uint64_t frame);

  // D13: the live-item and per-item command caps (GRC_MIRROR_MAX_ITEMS, GRC_MIRROR_MAX_COMMANDS;
  // defaults rs2::kMaxLiveItems and rs2::kMaxCommandsPerItem). reset() restores the defaults;
  // set once at arm, before the root query.
  void set_caps(std::size_t max_items, std::size_t max_commands);

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

  // --- render-stream/4 immediate geometry (G5d; gate5-design.md Q3b, render-stream-4.md
  // "Command") --------------------------------------------------------------------------------
  //
  // Each tap records the RenderingServer call argument for argument (every array whole, copied
  // by the hook on the calling thread), never its server-side lowering (D3), and bumps
  // content_version like add_rect. The omit-op name of each is its RenderingServer method name
  // (canvas_item_add_line, ...). `texture` arguments follow D11: a RID the mirror knows becomes
  // its wire id, an unknown non-null RID an `unsupported` command with `unknown-texture`, and
  // RID() becomes `tex: null` -- unless this is a headless host on which the session has already
  // created a canvas texture (canvas_texture_create), whose RID() is ambiguous with "no
  // texture": from then on every such op naming RID() is `unsupported` with
  // `canvas-texture-headless`. From set_perturb_vertex's frame on, the first point's x of every
  // add_line (from), add_polyline, add_multiline, add_primitive, add_polygon and
  // add_triangle_array gains +1.0 in the recorded command (Q3c); the engine is unaffected.
  void add_line(std::uint64_t item, const rs2::Point2 &from, const rs2::Point2 &to,
                const rs2::Color4 &color, float width, bool antialiased, std::uint64_t frame);
  // add_polyline and (multiline = true) add_multiline: width, aa, every point and colour as given.
  void add_polyline(std::uint64_t item, std::vector<rs2::Point2> points,
                    std::vector<rs2::Color4> colors, float width, bool antialiased, bool multiline,
                    std::uint64_t frame);
  void add_circle(std::uint64_t item, const rs2::Point2 &position, float radius,
                  const rs2::Color4 &color, bool antialiased, std::uint64_t frame);
  // add_primitive and (polygon = true) add_polygon: points, colours and UVs as given.
  void add_primitive(std::uint64_t item, std::vector<rs2::Point2> points,
                     std::vector<rs2::Color4> colors, std::vector<rs2::Point2> uvs,
                     std::uint64_t texture, bool polygon, std::uint64_t frame);
  // add_triangle_array: `skinned` (non-empty bones or weights) makes it `unsupported` with
  // `skinned-geometry` (D16); `count` is carried verbatim.
  void add_triangle_array(std::uint64_t item, std::vector<std::int32_t> indices,
                          std::vector<rs2::Point2> points, std::vector<rs2::Color4> colors,
                          std::vector<rs2::Point2> uvs, bool skinned, std::uint64_t texture,
                          std::int32_t count, std::uint64_t frame);
  // add_nine_patch: the engine's NinePatchAxisMode ints (0 stretch, 1 tile, 2 tile_fit; anything
  // else is recorded as an `unsupported-op` command).
  void add_nine_patch(std::uint64_t item, const rs2::Rect4 &rect, const rs2::Rect4 &source,
                      std::uint64_t texture, const rs2::Point2 &margin_tl,
                      const rs2::Point2 &margin_br, std::int32_t x_axis, std::int32_t y_axis,
                      bool draw_center, const rs2::Color4 &modulate, std::uint64_t frame);
  // add_set_transform / add_clip_ignore: ordered command-list state (D9, D10). The mirror keeps
  // no transform or clip-ignore state of its own: a receiver that replays the commands in order
  // reproduces the engine's per-item draw transform (reset per item, replaced not composed).
  void add_set_transform(std::uint64_t item, const rs2::Xform &transform, std::uint64_t frame);
  void add_clip_ignore(std::uint64_t item, bool ignore, std::uint64_t frame);

  // perturb-vertex sabotage (gate5-design.md Q3c, render-stream-4.md "Sabotage"); 0 disables it.
  // From G5e it also moves the first vertex's x of every mesh surface payload the mirror takes
  // from its frame on (a new copy, re-hashed); the hook log keeps the true hash.
  void set_perturb_vertex(std::uint64_t from_frame);

  // P3-TM (render-stream-10.md "Shader time"): a /10 session carries the host's shader time.
  // set_carry_shader_time(true) once before arming; set_shader_time() at every frame callback,
  // before the snapshot. Each snapshot whose state holds an `ok` shader reading TIME carries the
  // value, and a new value is a mirror change (the epoch moves) only while such a shader exists, so
  // a TIME-free session is unchanged.
  void set_carry_shader_time(bool carry);
  void set_shader_time(double time);

  // --- meshes (G5e; gate5-design.md D5-D8, Q3b, render-stream-4.md "Mesh table") ------------
  //
  // The mesh table: its own per-session id counter (from 1, never reused), `version` 1 at
  // creation and + 1 per accepted mutating call -- exactly the hook log's counting
  // (rs_resource_log.h), which the checker compares (`mesh-versions-current`). Surfaces are whole
  // GRM1 payloads (shared, never copied again), so a snapshot pins the versions it names. Only
  // omit-op applies to the mesh taps (never omit-update: the hook log has no notion of it); the
  // omit-op names are the RenderingServer method names. A mesh tap naming a RID the table does
  // not know is counted (`mesh_unknown`) and changes nothing.
  //
  // mesh_create: a new id, ok, version 1, no surfaces, custom AABB zero.
  void mesh_create(std::uint64_t rid, std::uint64_t frame);
  // mesh_create_from_surfaces: a new id, version 1, every surface added; a refused one makes the
  // entry `unsupported` with its reason (its slot is kept so later indices line up).
  void mesh_create_from_surfaces(std::uint64_t rid, const std::vector<MeshSurfaceInput> &surfaces,
                                 std::uint64_t frame);
  // G8r (gate8-design.md D6): a mesh that already existed when the capture armed, read back
  // through mesh_get_surface at its first reference. Exactly mesh_create_from_surfaces plus its
  // custom AABB, with origin `adopted` and adopted_content `creation` (the dummy keeps the
  // creation-time surfaces; region updates it dropped are not recoverable). Never dropped.
  void mesh_adopt(std::uint64_t rid, const std::vector<MeshSurfaceInput> &surfaces,
                  const std::array<float, 6> &custom_aabb, std::uint64_t frame);
  // mesh_add_surface: appended, version + 1.
  void mesh_add_surface(std::uint64_t rid, const MeshSurfaceInput &surface, std::uint64_t frame);
  // One of the four mesh_surface_update_*_region taps (`op` its method name). `applied` is the
  // hook's verdict (D8: GLES3's bounds; a rejected or unknown update changes nothing). Applied:
  // version + 1 and, when `updated` is non-null (an `ok` surface re-encoded by the hook), the
  // surface takes that payload; a null `updated` (an already-refused surface) is version + 1 only.
  void mesh_surface_update_region(std::uint64_t rid, const char *op, std::int32_t surface,
                                  bool applied, const MeshSurfaceInput *updated,
                                  std::uint64_t frame);
  // mesh_surface_remove: in range, the surface leaves and later ones renumber, version + 1.
  void mesh_surface_remove(std::uint64_t rid, std::int32_t surface, std::uint64_t frame);
  // mesh_clear: no surfaces, ok again, version + 1.
  void mesh_clear(std::uint64_t rid, std::uint64_t frame);
  // mesh_set_custom_aabb: position xyz, size xyz; version + 1.
  void mesh_set_custom_aabb(std::uint64_t rid, const std::array<float, 6> &aabb,
                            std::uint64_t frame);
  // canvas_item_add_mesh: the /4 add_mesh command (mesh id, transform, modulate, texture per
  // D11); a mesh RID the table does not know becomes an `unsupported` command with
  // `unknown-mesh`. Bumps content_version like every command.
  void add_mesh(std::uint64_t item, std::uint64_t mesh, const rs2::Xform &transform,
                const rs2::Color4 &modulate, std::uint64_t texture, std::uint64_t frame);

  // --- shaders, materials, item and canvas material state (G55d; gate5_5-design.md D4-D10, Q3b,
  // render-stream-5.md) ----------------------------------------------------------------------
  //
  // Two tables, each with its own per-session id counter (from 1, never reused) and `version` 1
  // at creation, + 1 per accepted mutating call -- the hook log's counting (rs_resource_log.h),
  // which the checker compares (`material-commands`). No tombstones (D5): freeing a shader sets
  // every material naming it to no shader (version + 1), freeing a material sets every item
  // naming it to `material: null`. Only omit-op applies to the shader and material taps (the hook
  // log has no omit-update); the item and canvas field taps are ordinary mutations (omit-op, then
  // omit-update). The omit-op names are the RenderingServer method names. A shader or material
  // tap naming a RID the table does not know changes nothing.
  //
  // GRC_SHADER_POLICY (D4), read at arm; survives until reset() (default Source). Params: every
  // non-builtin shader with code is `withheld` (hash and size kept, no payload anywhere). Exclude:
  // every non-builtin shader with code is `unsupported` / `shader-excluded`. A recognized
  // CanvasItemMaterial shader (D7) is engine content and travels as a payload under every policy.
  void set_shader_policy(rs2::ShaderPolicy policy);
  // perturb-shader sabotage (Q3c); 0 disables it. From `from_frame` on, every code the mirror
  // records for a non-builtin shader that contains the identifier `fragment` and ends (ignoring
  // whitespace) with `}` gets "\tCOLOR.rgb = vec3(1.0) - COLOR.rgb;\n" before that last `}` (a
  // new payload, re-hashed); the engine and the hook log keep the true code.
  void set_perturb_shader(std::uint64_t from_frame);
  // shader_create: a new id, ok, version 1, no code (mode, source and hash null).
  void shader_create(std::uint64_t rid, std::uint64_t frame);
  // shader_create_from_code: a new id, version 1, the code classified.
  void shader_create_from_code(std::uint64_t rid, const ShaderCodeInput &code, std::uint64_t frame);
  // shader_set_code: new payload and classification, version + 1.
  void shader_set_code(std::uint64_t rid, const ShaderCodeInput &code, std::uint64_t frame);
  // shader_set_default_texture_parameter: the (name, index) entry set to a known texture's id or
  // removed for RID(); an unknown texture RID removes it and marks the entry unresolvable (items
  // drawing with the shader then get `unsupported-material`). version + 1.
  void shader_set_default_texture_parameter(std::uint64_t rid, const std::string &name,
                                            std::uint64_t texture, std::int32_t index,
                                            std::uint64_t frame);
  // material_create: a new id, ok, version 1, shader null, no params.
  void material_create(std::uint64_t rid, std::uint64_t frame);
  // material_create_from_shader: a new id, version 1, shader set (an unknown non-null shader RID
  // leaves it null and makes the entry `unsupported` / `unknown-shader`).
  void material_create_from_shader(std::uint64_t rid, std::uint64_t shader, std::uint64_t frame);
  // material_set_shader: shader set (RID() -> null; unknown -> null + unknown-shader), version + 1.
  void material_set_shader(std::uint64_t rid, std::uint64_t shader, std::uint64_t frame);
  // material_set_param (D6, D8): NIL erases, OBJECT is rejected (no change, no version), a `rid`
  // names the texture table (RID() erases, as GLES3 then falls back to the default texture; an
  // unknown RID makes the entry `unknown-texture`), a param-type/param-range value makes the
  // entry `unsupported` until that name is set to a supported value or erased; version + 1 when
  // accepted.
  void material_set_param(std::uint64_t rid, const std::string &name, const DecodedParam &value,
                          std::uint64_t frame);
  // canvas_item_set_use_parent_material: the item field (D9).
  void set_use_parent_material(std::uint64_t item, bool enable, std::uint64_t frame);
  // --- render-stream/10 (CG1, render-stream-10.md "Capture"): the two conditional hooks ------
  // canvas_item_set_canvas_group_mode: mode 0 (disabled) clears the item's canvas_group, 1-3
  // replace it whole. A mode outside 0-3 changes nothing (the hook counts it). Item state, never
  // content_version; canvas_item_clear keeps it.
  void set_canvas_group_mode(std::uint64_t item, std::int32_t mode, float clear_margin,
                             bool fit_empty, float fit_margin, bool blur_mipmaps,
                             std::uint64_t frame);
  // canvas_item_set_copy_to_backbuffer: `enable` false clears it, true sets it with `rect` as the
  // engine received it (Rect2() is the whole target, the receiver's rule).
  void set_copy_to_backbuffer(std::uint64_t item, bool enable, const rs2::Rect4 &rect,
                              std::uint64_t frame);
  // canvas_item_set_instance_shader_parameter: instance_params[name] set (NIL kept as type nil,
  // OBJECT rejected, an unsupported type drops the name and adds the derived
  // `param-type` item entry until the name is set to a supported value).
  void set_instance_shader_parameter(std::uint64_t item, const std::string &name,
                                     const DecodedParam &value, std::uint64_t frame);
  // canvas_set_modulate: the canvas field (D10). An unknown canvas RID is the unknown-RID rule.
  void canvas_set_modulate(std::uint64_t canvas, const rs2::Color4 &color, std::uint64_t frame);
  // canvas_light_attach_to_canvas: a non-null canvas adds the sticky session-level entry
  // {op: canvas_light_attach_to_canvas, item: null, reason: canvas-light} (D10).
  void canvas_light_attach_to_canvas(std::uint64_t light, std::uint64_t canvas,
                                     std::uint64_t frame);

  // --- canvases on render-stream/6 (G6b; gate6-design.md D3, Q3b), calibrator 9 ---------------
  // viewport_attach_canvas (above) sets `attached` and resets the stacking to (0,0)
  // (rv.cpp:1265-1266); a canvas attached to the root viewport is supported (no extra-canvas).
  // viewport_remove_canvas: `attached = false`; the canvas and its items stay in the table.
  void viewport_remove_canvas(std::uint64_t viewport, std::uint64_t canvas, std::uint64_t frame);
  // viewport_set_canvas_stacking: the canvas's `layer` and `sublayer`.
  void viewport_set_canvas_stacking(std::uint64_t viewport, std::uint64_t canvas,
                                    std::int32_t layer, std::int32_t sublayer,
                                    std::uint64_t frame);
  // viewport_set_global_canvas_transform: the root's current global canvas transform. While it
  // differs bitwise from the arm-time reference (set_global_canvas_reference) every snapshot
  // carries {op: viewport_set_global_canvas_transform, item: null, reason:
  // global-canvas-transform}.
  void viewport_set_global_canvas_transform(std::uint64_t viewport, const rs2::Xform &xform,
                                            std::uint64_t frame);
  // canvas_set_item_mirroring / canvas_set_item_repeat: a non-zero vector adds the sticky
  // session-level canvas-repeat entry named after the op.
  void canvas_set_item_mirroring(std::uint64_t canvas, std::uint64_t item, float x, float y,
                                 std::uint64_t frame);
  void canvas_set_item_repeat(std::uint64_t item, float x, float y, std::int32_t times,
                              std::uint64_t frame);
  // canvas_set_parent: a non-null parent adds the sticky session-level canvas-follow-viewport
  // entry; RID() changes nothing.
  void canvas_set_parent(std::uint64_t canvas, std::uint64_t parent, std::uint64_t frame);
  // Arm-time declarations (Q3a): the stretch x global transform the global canvas transform is
  // compared with (the session's host_final_xform), and the root's snap_2d flags (D17; either
  // set -> every snapshot carries the session-level snap-2d entry). Both survive until reset().
  void set_global_canvas_reference(const rs2::Xform &xform);
  void set_snap_2d(bool transforms, bool vertices);

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
  // G8kw (rs_texture_worker.h): with a `job`, an "ok" copy is a hook-time prediction whose hash
  // and bytes the job delivers; the entry is `ok` and pending until a snapshot settles it.
  void texture_2d_create(std::uint64_t rid, const PayloadCopy &copy, PayloadPtr bytes,
                         std::uint64_t frame, std::shared_ptr<TextureJob> job = nullptr);
  // G8r (gate8-design.md D6, D7): a texture that already existed when the capture armed, met at
  // its first reference by a hooked call. Exactly texture_2d_create (a new id, kind image, version
  // 1, status from the copy, G8kw's job) but with origin `adopted` and `content` (Current or
  // Creation) as its adopted_content. Identity bookkeeping: no omit-op name, never dropped.
  void texture_adopt(std::uint64_t rid, const PayloadCopy &copy, PayloadPtr bytes,
                     rs2::AdoptedContent content, std::uint64_t frame,
                     std::shared_ptr<TextureJob> job = nullptr);
  // G8r: whether `rid` is in the texture / mesh table (a live entry, not a tombstone).
  bool knows_texture(std::uint64_t rid) const;
  bool knows_mesh(std::uint64_t rid) const;

  // --- G8m (gate8-design.md D11, D12, Q5): pre-arm shaders and materials, adopted with origin
  // `adopted` through the same tables. Identity bookkeeping: no omit-op name, never dropped.
  // shader_adopt: exactly shader_create_from_code (the code the capture recovered: a temporary
  // Shader's preprocessed code, or a CanvasItemMaterial template), origin adopted.
  void shader_adopt(std::uint64_t rid, const ShaderCodeInput &code, std::uint64_t frame);
  // shader_adopt_refused: a shader that exists but whose code cannot be recovered (Q5's
  // shader-adopt-include): no code, `unsupported` with `reason`, origin adopted.
  void shader_adopt_refused(std::uint64_t rid, rs2::ShaderReason reason, std::uint64_t frame);
  // material_adopt: exactly material_create, origin adopted (its shader and parameters then arrive
  // through material_set_shader / material_set_param, as the hooks would have declared them).
  void material_adopt(std::uint64_t rid, std::uint64_t frame);
  bool knows_shader(std::uint64_t rid) const;
  bool knows_material(std::uint64_t rid) const;
  // The code of a known shader's GRP1 payload (false when it has none).
  bool shader_code_of(std::uint64_t rid, std::string *code) const;
  // Re-keys a shader entry from `old_rid` to `new_rid` (G8m: a CanvasItemMaterial template shader
  // adopted before its engine RID was known, D12), keeping its id; nothing when `new_rid` is known.
  void shader_rebind(std::uint64_t old_rid, std::uint64_t new_rid);
  // The references the mirror could not resolve (rs_adopt.cpp resolves them at the next frame
  // boundary): items whose last canvas_item_set_material named an unknown material, and
  // materials whose last shader named an unknown shader, each with the items that draw with it
  // as their own material. `epoch` advances whenever such a reference may have appeared or
  // gained an item, so a caller can skip an unchanged set.
  struct PendingMaterialRefs {
    std::vector<std::pair<std::uint64_t, std::uint64_t>> items;  // (item RID, material RID)
    struct MaterialRef {
      std::uint64_t material = 0;
      std::uint64_t shader = 0;
      std::vector<std::uint64_t> items;  // item RIDs whose own material it is
    };
    std::vector<MaterialRef> materials;
  };
  std::uint64_t material_refs_epoch() const;
  PendingMaterialRefs pending_material_refs() const;
  // texture_2d_placeholder_create: a new id, kind placeholder, version 1.
  void texture_2d_placeholder_create(std::uint64_t rid, std::uint64_t frame);
  // texture_2d_update: a known id gets version + 1 and, when the layer is 0 and
  // the shape equals the texture's, the new payload; otherwise it becomes
  // `unsupported` (`layered-update`, `update-shape-mismatch`). An unknown RID is
  // counted (texture_update_unknown) and changes nothing.
  void texture_2d_update(std::uint64_t rid, const PayloadCopy &copy, PayloadPtr bytes, int layer,
                         std::uint64_t frame, std::shared_ptr<TextureJob> job = nullptr);
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
  // and the payload of every `ok` image entry. Since G5e it also holds the mesh
  // table (sorted by id; a `freed` tombstone leaves at the first snapshot in
  // which no add_mesh names it), the derived `unsupported-mesh` entries, and
  // every `ok` mesh's surface payloads (Captured::payloads holds both kinds).
  Captured snapshot(std::uint64_t seq, std::uint64_t frame);

  // --- G8ku: lazy Basis variants (texture-delivery-design.md D6, D12; rs_texture_delivery.h) --
  //
  // `submit` queues an encode (rs_texture_basis.h submit_basis_job); null (the default, and every
  // stream but /9 basis-uastc) means no encode is ever started. Survives reset().
  using BasisSubmit = std::function<bool(const BasisJobPtr &)>;
  void set_basis_submit(BasisSubmit submit);
  // Called by the frame callback before the snapshot (main thread). Starts an encode for every
  // settled ok image that D12 admits and has none for its current content, and attaches every
  // finished one whose content is still current (one more variant at an equal `version`, D6: the
  // epoch advances, so the next transaction carries a patch entry). `attach` false keeps finished
  // results for later (GRC_TEXTURE_ENCODE_WAIT_FRAME before its frame); `wait` first waits for
  // every encode in flight (that frame itself). Returns the number of variants attached.
  std::size_t service_basis(bool attach, bool wait);
  // G8kf: GRC_TEXTURE_PENDING=publish (see TextureWorkerConfig). The frame callback calls
  // service_pending() before it reads the epoch: a texture published as `delivery-pending` whose
  // worker has finished gets its next version, which advances the epoch (a mutation).
  void set_publish_pending(bool on);
  void service_pending();
  std::uint64_t pending_published() const;
  // Every unfinished encode job (stream end: entry.cpp abandons them after the pool dropped them).
  std::vector<BasisJobPtr> basis_jobs() const;

  MirrorStats stats() const;

 private:
  struct Item {
    rs2::ItemState state;
    std::uint64_t rid = 0;
    // G55d (render-stream-5.md "Item"): the last canvas_item_set_material named a non-null RID
    // the material table does not know -- `material: null` plus the derived `unknown-material`.
    bool unknown_material = false;
    std::uint64_t unknown_material_rid = 0;  // G8m: that RID (0 when none)
    // G55d: instance parameters (sorted by name on publication) and the names whose last value
    // had an unsupported type (the derived `param-type` entry while non-empty).
    std::map<std::string, rs2::Param> instance_params;
    std::set<std::string> instance_param_unsupported;
    // Non-null skeleton (gate5-design.md D2, calibrator 7): same idea, its own op name.
    bool unsupported_skeleton = false;
    // Skip policy only: the unknown RID this item was parented to (state.parent is then None and
    // the item is in no child list); 0 otherwise.
    std::uint64_t unknown_parent = 0;
    // Emitted by at least one snapshot (decides whether entering a withheld subtree re-keys it).
    bool published = false;
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
    // G8r (render-stream-8.md "Resource tables"): `adopted` for a texture the capture met already
    // existing at arm; its adopted_content (None exactly when origin is Created).
    rs2::Origin origin = rs2::Origin::Created;
    rs2::AdoptedContent adopted_content = rs2::AdoptedContent::None;
    // The last accepted copy's description (kind image): its shape decides
    // whether an update is accepted, as in the hook log.
    PayloadCopy copy;
    PayloadPtr bytes;  // the payload while status is ok and kind image
    // G8kw: the worker delivering `copy.hash` and `bytes` (null once settled, or when synchronous).
    std::shared_ptr<TextureJob> job;
    // G8kf (render-stream-9.md "Texture reasons"): `published_ok` once a snapshot carried this
    // texture as an `ok` entry; `pending_version` the version a snapshot carried it at as
    // `delivery-pending` (0: none). The entry returns as `ok` at the next version.
    bool published_ok = false;
    std::uint64_t pending_version = 0;
    // G8ku (D6, D12): `updated` once a texture_2d_update reached it (D12(a): never Basis after);
    // the encode of the current content while it runs; the attached uastc variant; and
    // `basis_decided` once this content's Basis outcome is known (attached, declined, failed).
    bool updated = false;
    BasisJobPtr basis;
    std::string uastc_hash;
    std::string uastc_params;
    PayloadPtr uastc_bytes;
    bool basis_decided = false;
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
  // One mesh surface (G5e): `ok` with its payload, or refused (D7) with its reason only.
  struct MeshSurf {
    bool ok = false;
    rs2::MeshReason reason = rs2::MeshReason::MeshFormat;
    PayloadPtr bytes;
    std::string hash;
    std::int32_t primitive = 0;
    std::int64_t format = 0;
    std::int32_t vertex_count = 0;
    std::int32_t index_count = 0;
  };
  struct Mesh {
    std::uint32_t id = 0;
    std::uint64_t rid = 0;  // 0 once freed (a tombstone)
    rs2::MeshStatus status = rs2::MeshStatus::Ok;
    bool has_reason = false;
    rs2::MeshReason reason = rs2::MeshReason::MeshFormat;
    std::uint64_t version = 1;
    rs2::Origin origin = rs2::Origin::Created;  // G8r, as Texture's
    rs2::AdoptedContent adopted_content = rs2::AdoptedContent::None;
    std::vector<MeshSurf> surfaces;
    std::array<float, 6> custom_aabb = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
  };
  // One shader (G55d). `has_code` false: shader_create'd, no shader_set_code yet.
  struct Shader {
    std::uint32_t id = 0;
    std::uint64_t rid = 0;
    std::uint64_t version = 1;
    rs2::Origin origin = rs2::Origin::Created;  // G8m: `adopted` for a pre-arm shader
    bool refused = false;                       // G8m: shader_adopt_refused (no code, `reason`)
    rs2::ShaderReason refused_reason = rs2::ShaderReason::ShaderMode;
    bool has_code = false;
    ShaderCopy copy;     // the hook's classification (perturb-shader: hash/size of the new copy)
    PayloadPtr bytes;    // the GRP1 payload (null when the hook built none)
    // (name, index) -> texture-table id; unresolvable_defaults counts entries whose last set
    // named an unknown texture RID.
    std::map<std::pair<std::string, std::int32_t>, std::uint32_t> default_textures;
    std::set<std::pair<std::string, std::int32_t>> unresolvable_defaults;
  };
  // One material parameter as the table keeps it: supported (`param`) or refused (`reason`).
  struct MaterialParam {
    bool ok = true;
    rs2::MaterialReason reason = rs2::MaterialReason::ParamType;
    rs2::Param param;
  };
  struct Material {
    std::uint32_t id = 0;
    std::uint64_t rid = 0;
    std::uint64_t version = 1;
    bool has_shader = false;
    std::uint32_t shader = 0;
    bool shader_unknown = false;  // the last shader set named an unknown non-null RID
    std::uint64_t unknown_shader_rid = 0;       // G8m: that RID (0 when none)
    rs2::Origin origin = rs2::Origin::Created;  // G8m: `adopted` for a pre-arm material
    std::map<std::string, MaterialParam> params;
    // P3-CAP: the published form of `params` (wire_params()), rebuilt only when `version` moved
    // since it was built -- every change to `params` bumps `version`. A game's particle
    // materials carry ~64 parameters each; rebuilding all of them every frame was most of the
    // snapshot.
    struct WireParams {
      std::uint64_t version = 0;  // 0: never built (versions start at 1)
      rs2::SharedVector<rs2::Param> params;  // the ok ones, in name order
      bool unsupported = false;              // some parameter is not ok ...
      rs2::MaterialReason reason = rs2::MaterialReason::ParamType;  // ... the first one's reason
      std::vector<std::uint32_t> textures;  // the texture ids of the ok rid parameters
    };
    mutable WireParams wire;
  };
  enum class Kind : std::uint8_t { Canvas, Item };
  struct Target {
    Kind kind;
    std::uint32_t id;
  };

  // All private helpers expect mutex_ held.
  // Identity taps: only omit-op applies. Advances the epoch when not dropped.
  void create_canvas(std::uint64_t rid, std::uint64_t frame, rs2::Origin origin);
  void create_item(std::uint64_t rid, std::uint64_t frame, rs2::Origin origin);
  bool dropped_identity(const char *op, std::uint64_t frame);
  // Mutation taps: omit-op, then omit-update. Advances the epoch when not dropped.
  bool dropped(const char *op, std::uint64_t frame);
  bool omit_op_matches(const char *op, std::uint64_t frame) const;
  Item *find_item(std::uint64_t rid);
  bool find_target(std::uint64_t rid, Target *out) const;
  // Looks the item up for a mutating op: unknown -> unknown() (pre-existing-object, or counted
  // under Skip), an item untracked because of the cap -> silently ignored.
  Item *item_for(std::uint64_t rid, const char *op, std::uint64_t frame);
  // Strict: the sticky pre-existing-object failure. Skip: counts the call and remembers `rid`.
  void unknown(std::uint64_t rid, const char *op, std::uint64_t frame);
  bool skip_unknown() const { return unknown_policy_ == rs2::UnknownItemPolicy::Skip; }
  // Skip: the ids of every known item whose parent chain reaches an unknown RID.
  std::set<std::uint32_t> withheld_ids() const;
  bool is_withheld(const Item &item) const;
  // Skip: gives every published item of the subtree rooted at `id` a fresh wire id.
  void rekey_subtree(std::uint32_t id);
  // Skip: `rid` stops being unknown (freed, or a recycled RID value created anew); the items
  // parented to it are orphaned, as the engine orphans the children of a freed item.
  bool forget_unknown(std::uint64_t rid);
  void fail(rs2::FailureReason reason, const std::string &detail);
  void session_unsupported(const char *op, rs2::UnsupportedReason reason);
  std::vector<std::uint32_t> *children_of(rs2::ParentKind kind, std::uint32_t id);
  void detach(Item *item);
  // Appends one command (cap checked) and bumps content_version.
  void push_command(Item *item, rs2::Command command, std::uint64_t frame);
  // `rect` with perturb-glyph applied when it is active at `frame`.
  rs2::Rect4 perturbed_glyph(const rs2::Rect4 &rect, std::uint64_t frame) const;
  // `point` with perturb-vertex applied when it is active at `frame` (G5d).
  rs2::Point2 perturbed_vertex(const rs2::Point2 &point, std::uint64_t frame) const;
  // D11 for a /4 op's texture argument: fills command->has_tex/tex and returns true, or turns
  // the command into an `unsupported` one named `op` (canvas-texture-headless or
  // unknown-texture) and returns false.
  bool geometry_texture(std::uint64_t texture, const char *op, rs2::Command *command) const;
  // Shared prologue of the /4 taps: the item to record into, or nullptr (dropped / unknown).
  Item *geometry_item(std::uint64_t rid, const char *op, std::uint64_t frame);
  // A texture argument as a command: tex id / null, or false for an unknown RID.
  bool texture_ref(std::uint64_t rid, bool *has_tex, std::uint32_t *tex) const;
  Texture *find_texture(std::uint64_t rid);
  bool texture_referenced(std::uint32_t id) const;
  // Takes `id` out of the table: a `freed` tombstone while a command names it,
  // gone otherwise.
  void retire_texture(std::uint32_t id);
  static rs2::TextureEntry wire_entry(const Texture &texture);
  // G8kw: a finished job's hash and bytes move into the entry (no-op without one).
  static void settle(Texture *texture);
  // G8kf: a texture a snapshot carried as `delivery-pending`, once its job is gone, takes its next
  // version (true when it did). Needs the lock.
  static bool resolve_pending(Texture *texture);
  static void reset_basis(Texture *texture);  // G8ku: a content change drops the Basis state
  BasisSubmit basis_submit_;
  // Meshes (G5e).
  Mesh *find_mesh(std::uint64_t rid);
  // A mesh tap's prologue: omit-op (and the epoch), then the entry, or nullptr (counted unknown).
  Mesh *mesh_for(std::uint64_t rid, const char *op, std::uint64_t frame);
  // One surface as the table keeps it, perturb-vertex applied when active at `frame`.
  MeshSurf mesh_surface(const MeshSurfaceInput &input, std::uint64_t frame) const;
  static void recompute_mesh_status(Mesh *mesh);
  bool mesh_referenced(std::uint32_t id) const;
  // Takes `id` out of the table: a `freed` tombstone while a command names it, gone otherwise.
  void retire_mesh(std::uint32_t id);
  static rs2::MeshEntry wire_mesh(const Mesh &mesh);
  // Shaders and materials (G55d).
  Shader *find_shader(std::uint64_t rid);
  Material *find_material(std::uint64_t rid);
  // Records `code` into `shader` (classification and payload, perturb-shader applied at `frame`).
  void take_shader_code(Shader *shader, const ShaderCodeInput &code, std::uint64_t frame) const;
  rs2::ShaderEntry wire_shader(const Shader &shader) const;
  // P3-TM: whether `shader` is an `ok` wire shader whose `uses` names `time` (wire_shader's
  // status rules, without building the entry).
  bool reads_time(const Shader &shader) const;
  static rs2::MaterialEntry wire_material(const Material &material);
  // P3-CAP: material.wire, brought up to date with material.version.
  static const Material::WireParams &wire_params(const Material &material);
  // A decoded Variant as a wire Param (`tex` already resolved by the caller for a rid); false
  // with `reason` set for an unsupported value.
  bool to_param(const std::string &name, const DecodedParam &value, rs2::Param *out,
                rs2::MaterialReason *reason) const;
  // D9: the material id an item draws with (own, or up the parent chain while
  // use_parent_material), 0 for none.
  std::uint32_t effective_material(const Item &item) const;
  // render-stream-5.md "Derived item-level entries": the effective material is unsupported,
  // names an unsupported shader, or names a texture parameter or default texture whose entry is
  // unsupported (or unresolvable).
  bool material_unsupported(std::uint32_t material_id) const;
  // render-stream-1.md "Invariant 9" over one container's child list.
  void find_ties(const std::vector<std::uint32_t> &children,
                 std::vector<rs2::UnsupportedRef> *out) const;

  mutable std::mutex mutex_;
  std::uint64_t epoch_ = 0;
  bool publish_pending_ = false;          // G8kf: GRC_TEXTURE_PENDING=publish
  std::uint64_t pending_published_ = 0;   // delivery-pending entries snapshots carried
  std::set<std::uint32_t> pending_ids_;   // the textures the snapshot being taken carries as pending
  std::uint64_t drop_frame_ = 0;
  std::string omit_op_;
  std::uint64_t omit_from_frame_ = 0;
  std::uint64_t perturb_glyph_frame_ = 0;
  std::uint64_t perturb_vertex_frame_ = 0;
  bool carry_shader_time_ = false;  // P3-TM
  double shader_time_ = 0.0;        // P3-TM: the last set_shader_time()
  bool degenerate_host_size_ = false;
  // G6b (Q3a, Q3b): the arm-time global canvas transform reference and the latest value the root
  // viewport set; the root's snap_2d flags.
  rs2::Xform global_reference_ = rs2::kIdentityXform;
  rs2::Xform global_current_ = rs2::kIdentityXform;
  bool snap_transforms_ = false;
  bool snap_vertices_ = false;
  bool canvas_texture_headless_ = false;
  // D11 (G5d): a canvas_texture_create returned RID() this session (sticky until reset()). On a
  // headless host it makes RID() on the /4 geometry ops ambiguous. A create with a non-null RID
  // (a rendered host, or the opt-in headless shim's private RID) does not set it.
  bool canvas_texture_created_ = false;
  rs2::UnknownItemPolicy unknown_policy_ = rs2::UnknownItemPolicy::Strict;
  std::size_t max_items_ = rs2::kMaxLiveItems;
  std::size_t max_commands_ = rs2::kMaxCommandsPerItem;
  std::unordered_set<std::uint64_t> unknown_rids_;  // Skip: named, not yet freed
  std::uint32_t next_canvas_id_ = rs2::kRootCanvasId + 1;
  std::uint32_t next_item_id_ = 1;
  std::uint64_t root_viewport_rid_ = 0;
  std::map<std::uint32_t, Canvas> canvases_;  // ordered by id
  std::map<std::uint32_t, Item> items_;        // ordered by id
  std::map<std::uint32_t, Texture> textures_;  // ordered by id, tombstones included
  std::unordered_map<std::uint64_t, std::uint32_t> texture_by_rid_;
  std::uint32_t next_texture_id_ = 1;
  std::map<std::uint32_t, Mesh> meshes_;  // ordered by id, tombstones included (G5e)
  std::unordered_map<std::uint64_t, std::uint32_t> mesh_by_rid_;
  std::uint32_t next_mesh_id_ = 1;
  // G55d: shaders and materials (no tombstones, D5).
  std::map<std::uint32_t, Shader> shaders_;
  std::unordered_map<std::uint64_t, std::uint32_t> shader_by_rid_;
  std::uint32_t next_shader_id_ = 1;
  std::map<std::uint32_t, Material> materials_;
  std::unordered_map<std::uint64_t, std::uint32_t> material_by_rid_;
  std::uint32_t next_material_id_ = 1;
  rs2::ShaderPolicy shader_policy_ = rs2::ShaderPolicy::Source;
  std::uint64_t material_refs_epoch_ = 0;  // G8m: see pending_material_refs()
  std::uint64_t perturb_shader_frame_ = 0;
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
void mirror_set_unknown_item_policy(rs2::UnknownItemPolicy policy);
void mirror_set_caps(std::size_t max_items, std::size_t max_commands);
void mirror_set_drop_frame(std::uint64_t frame);
void mirror_set_omit_op(const std::string &op, std::uint64_t from_frame);
void mirror_set_perturb_glyph(std::uint64_t from_frame);
void mirror_set_perturb_vertex(std::uint64_t from_frame);
void mirror_set_perturb_shader(std::uint64_t from_frame);
void mirror_set_shader_policy(rs2::ShaderPolicy policy);
std::uint64_t mirror_epoch();
Captured mirror_snapshot(std::uint64_t seq, std::uint64_t frame);
MirrorStats mirror_stats();

// The process-wide Mirror, for the hook taps. Callers check mirror_enabled()
// first; the object itself does not.
Mirror &mirror_instance();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_MIRROR_H
