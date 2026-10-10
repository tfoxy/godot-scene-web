// The texture hook log, `evidence/resources.jsonl`
// (`render-stream-resource-log/1`; gate2-design.md Q3 "Hook log", G2a).
//
// One JSON line per texture-related RenderingServer call the capture saw while
// a stream is enabled, written after the call was forwarded. It is the
// checker's ground truth for "what happened to textures and when"; it is never
// derived from the stream. G2a has no texture mirror yet, so this module keeps
// its own minimal registry of the textures it saw created -- RID -> wire id,
// kind, version and the last payload description -- with the D2 identity
// rules (one per-session id counter shared by images, placeholders and canvas
// textures, never reused; version 1 at creation, +1 per content or kind
// change), so every line names the id and version G2b2's mirror will assign.
//
// Engine-free and thread-safe: hooks call the taps from any thread (texture
// creation runs on loader threads), under one mutex; the frame callback drains
// the buffered lines into the file on the main thread.
//
// Line keys, in order (the contract's, then G2a's additions):
//   frame, t_us, thread ("main" | "other"), op, id, by_id, rid, version, kind,
//   status, reason, format, width, height, mipmaps, data_bytes, payload_bytes,
//   hash, copy_ns, hash_ns, conn, http_status,
//   target    the item, viewport or texture RID the call names besides `rid`
//             (decimal string) or null
//   ref_id    the wire id of `target` when it is a known texture, else null
//   value     the enum or channel argument (filter, repeat, channel) or null
//   layer     texture_2d_update's layer, else null
//   root_viewport  viewport_set_default_*: whether `target` is the root viewport
// and, since G2b2, only on a sabotage's own lines:
//   sabotage  true (spurious-texture-update's bump, or an omit-op line)
//   omitted   true (the omit-op sabotage dropped the call from the capture)
// G2b2 also writes publisher lines: op "store" and "inline", with `hash`,
// `payload_bytes`, `status` ("ok" | "failed") and, for a live stream, `conn`.
// G2c2 adds the live serving lines (serve_event): op "pin" (a hash became
// servable over HTTP at this frame callback; `reason` "current"), "retire" (it
// stopped being servable and its bytes were released; `reason` "superseded",
// or "unpin" when the unpin sabotage retired a hash a connection's base still
// names) and "http-get" (one resource GET the server answered: `hash` as
// requested, `http_status`, `payload_bytes` the body size, `conn` the live
// connection streaming at that time or null, `t_us` the I/O thread's time). A
// drop-resource pin line carries "sabotage":true.
//
// G5a (gate5-design.md Q3d) adds mesh lines, `kind: "mesh"`: one per mesh-related
// RenderingServer call (mesh_create, mesh_create_from_surfaces, mesh_add_surface, the four region
// updates, mesh_surface_remove, mesh_clear, mesh_set_custom_aabb, free). There is no mesh mirror
// table yet (that is G5e), so this module keeps its own minimal mesh registry too -- RID -> wire
// id, version, status, reason and, per surface, the current whole-buffer bytes needed to re-hash
// after a region update -- with its own per-session id counter (from 1, never reused, independent
// of the texture counter: D5). `hash` is the GRM1 payload's SHA-256 (rs_mesh_payload.h) and
// `format` is the raw ArrayFormat bitfield on a mesh line (never the texture format name, which
// stays a quoted string); both share the same column with the texture fields since a line is
// never both kinds. Trailing keys, present (null unless relevant) on every line: `surface` (index),
// `buffer` ("vertex" | "attribute" | "skin" | "index", a region update only), `offset`, `bytes`
// (the region update's own offset/length), `primitive`, `vertex_count`, `index_count` and
// `outcome` ("applied" | "rejected" | "unknown": a region update out of bounds is "rejected", one
// naming an unknown mesh or surface is "unknown", everything else that reaches the registry is
// "applied"). omit-op on a mesh call writes its line with "sabotage":true,"omitted":true and
// leaves the registry untouched, as the texture taps do.
#ifndef GRC_RS_RESOURCE_LOG_H
#define GRC_RS_RESOURCE_LOG_H

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace grc {
namespace rs {

// What the hook read and copied from a texture_2d_create/_update Image.
struct PayloadCopy {
  std::string status = "unsupported";  // "ok" | "unsupported"
  std::string reason;                  // "" when ok; unsupported-format, payload-too-large,
                                       // payload-unavailable
  std::int64_t format = -1;            // Image::Format, -1 when unread
  std::int64_t width = -1;             // -1 when unread
  std::int64_t height = -1;
  bool mipmaps_known = false;
  bool mipmaps = false;
  std::int64_t data_bytes = -1;  // Image::get_data_size(), -1 when unread
  std::int64_t payload_bytes = 0;
  std::string hash;      // lowercase hex SHA-256 of the payload, empty unless ok
  std::int64_t copy_ns = -1;  // -1 when nothing was copied
  std::int64_t hash_ns = -1;
};

// Where and when a tap ran.
struct TapContext {
  std::uint64_t frame = 0;
  std::uint64_t t_ns = 0;
  bool main_thread = true;
};

// What the hook read and copied from one surface of a mesh_add_surface /
// mesh_create_from_surfaces call, or produced by re-hashing a surface after a region update
// (gate5-design.md D6, D7, Q4). `format` is the raw ArrayFormat bitfield (rs_mesh_payload.h).
struct MeshSurfaceCopy {
  std::string status = "unsupported";  // "ok" | "unsupported"
  std::string reason;                  // "" when ok; mesh-format, mesh-blend-shapes,
                                       // payload-too-large
  std::int32_t primitive = -1;
  std::uint64_t format = 0;
  std::int64_t vertex_count = -1;
  std::int64_t index_count = -1;
  std::string hash;      // lowercase hex SHA-256 of the GRM1 payload, empty unless ok
  std::int64_t copy_ns = -1;  // -1 when nothing was copied
  std::int64_t hash_ns = -1;
};

class ResourceLog {
 public:
  // Starts a fresh session: ids restart at 1, the registry empties, buffered
  // lines are dropped. `t0_ns` is the origin of every line's t_us.
  void start(std::uint64_t t0_ns, std::uint64_t root_viewport_rid);
  void stop();
  bool active() const;

  // `omitted` (G2b2): the omit-op sabotage dropped this call from the capture.
  // The line is still written, marked "sabotage":true,"omitted":true, with the
  // registry's unchanged id and version, and the registry is not changed, so
  // it keeps agreeing with the mirror (which dropped the call too).
  void texture_2d_create(const TapContext &ctx, std::uint64_t rid, const PayloadCopy &copy,
                         bool omitted = false);
  void texture_2d_update(const TapContext &ctx, std::uint64_t rid, const PayloadCopy &copy,
                         int layer, bool omitted = false);
  void texture_2d_placeholder_create(const TapContext &ctx, std::uint64_t rid,
                                     bool omitted = false);
  void texture_replace(const TapContext &ctx, std::uint64_t texture, std::uint64_t by_texture,
                       bool omitted = false);
  // Logs only RIDs it knows as a texture or a mesh (every other free changes nothing here).
  void free_rid(const TapContext &ctx, std::uint64_t rid, bool omitted = false);
  // spurious-texture-update sabotage (G2b2): `rid`'s version + 1 with the same
  // payload, logged as a texture_2d_update marked "sabotage":true.
  void spurious_update(const TapContext &ctx, std::uint64_t rid);
  // A publisher event (G2b2): op "store" (a payload written to the store
  // directory) or "inline" (a resource record written to a stream), with its
  // hash, payload size and status ("ok" or "failed"); `conn` is the live
  // connection (0 = null, a file sink).
  void resource_event(const TapContext &ctx, const char *op, const std::string &hash,
                      std::uint64_t payload_bytes, const char *status, std::uint64_t conn = 0);
  // A live serving event (G2c2): op "pin", "retire" or "http-get" (see the
  // header comment). `http_status` < 0 is null; `conn` 0 is null.
  void serve_event(const TapContext &ctx, const char *op, const std::string &hash,
                   std::uint64_t payload_bytes, const char *reason, std::uint64_t conn,
                   std::int64_t http_status, bool sabotage);
  // `omitted` (G2d, as the other texture taps): the omit-op sabotage dropped this call; the
  // registry is left unchanged and the line is marked "sabotage":true,"omitted":true.
  // A create returning RID(), or a set_* on RID() (a headless host, whose dummy storage never
  // allocates a canvas texture), spends no id and is logged with status "unsupported", reason
  // "canvas-texture-headless" (protocol/canvas-texture-headless.md).
  void canvas_texture_create(const TapContext &ctx, std::uint64_t rid, bool omitted = false);
  void canvas_texture_set_channel(const TapContext &ctx, std::uint64_t canvas_texture,
                                  std::int32_t channel, std::uint64_t texture,
                                  bool omitted = false);
  void canvas_texture_set_filter(const TapContext &ctx, std::uint64_t canvas_texture,
                                 std::int32_t filter, bool omitted = false);
  void canvas_texture_set_repeat(const TapContext &ctx, std::uint64_t canvas_texture,
                                 std::int32_t repeat, bool omitted = false);
  void canvas_item_set_default_texture_filter(const TapContext &ctx, std::uint64_t item,
                                              std::int32_t filter);
  void canvas_item_set_default_texture_repeat(const TapContext &ctx, std::uint64_t item,
                                              std::int32_t repeat);
  void viewport_set_default_texture_filter(const TapContext &ctx, std::uint64_t viewport,
                                           std::int32_t filter);
  void viewport_set_default_texture_repeat(const TapContext &ctx, std::uint64_t viewport,
                                           std::int32_t repeat);

  // --- meshes (gate5-design.md Q3d, G5a) -------------------------------------
  //
  // mesh_create: a new id, status ok, version 1, no surfaces.
  void mesh_create(const TapContext &ctx, std::uint64_t rid, bool omitted = false);
  // mesh_create_from_surfaces: a new id, version 1, every surface classified (D7) and copied when
  // ok; one refused surface makes the whole entry unsupported with its reason (the first one
  // found), but every surface's bytes are still kept so later region updates still line up.
  void mesh_create_from_surfaces(const TapContext &ctx, std::uint64_t rid,
                                 const std::vector<MeshSurfaceCopy> &surfaces,
                                 bool omitted = false);
  // mesh_add_surface: appended at the next index, version + 1; a refused surface makes the entry
  // unsupported (the surface is still kept, so later indices still line up).
  void mesh_add_surface(const TapContext &ctx, std::uint64_t rid, const MeshSurfaceCopy &surface,
                        bool omitted = false);
  // mesh_surface_update_vertex_region / _attribute_region / _skin_region / _index_region:
  // `buffer` is "vertex" | "attribute" | "skin" | "index". `outcome` is "unknown" for an unknown
  // mesh or an out-of-range surface index, "rejected" for an out-of-bounds or empty update
  // (gles3m:536-594), else "applied" with the surface's new whole-payload `MeshSurfaceCopy`
  // (version + 1). A rejected or unknown update changes nothing.
  void mesh_surface_update_region(const TapContext &ctx, std::uint64_t rid, const char *buffer,
                                  std::int32_t surface, std::int32_t offset, std::int64_t bytes,
                                  const char *outcome, const MeshSurfaceCopy *new_surface,
                                  bool omitted = false);
  // mesh_surface_remove: in range, the surface is removed and later ones renumbered, version + 1;
  // out of range or an unknown mesh is "unknown" and changes nothing.
  void mesh_surface_remove(const TapContext &ctx, std::uint64_t rid, std::int32_t surface,
                           bool omitted = false);
  // mesh_clear: no surfaces, version + 1; an unsupported entry becomes ok again (its refused
  // surfaces are gone too).
  void mesh_clear(const TapContext &ctx, std::uint64_t rid, bool omitted = false);
  // mesh_set_custom_aabb: version + 1 (the AABB itself is not logged here: it is a mirror field,
  // gate5-design.md Q3b).
  void mesh_set_custom_aabb(const TapContext &ctx, std::uint64_t rid, bool omitted = false);

  // The wire id of a texture RID the log knows, or 0.
  std::uint64_t texture_id(std::uint64_t rid) const;
  // The wire id of a mesh RID the log knows, or 0.
  std::uint64_t mesh_id(std::uint64_t rid) const;

  // Takes every line buffered since the last call ("" when none), each ending
  // in '\n'.
  std::string take_lines();

  // texture_2d_update calls whose RID was never seen created.
  std::uint64_t update_unknown() const;

  // One line's values (rs_resource_log.cpp).
  struct Line;

 private:
  struct Entry {
    std::uint64_t id = 0;
    std::string kind;  // image | placeholder | canvas
    std::uint64_t version = 1;
    std::string status = "ok";
    std::string reason;
    PayloadCopy payload;  // kind image
    std::int32_t filter = 0;  // kind canvas
    std::int32_t repeat = 0;
    std::map<std::int32_t, std::uint64_t> channels;
  };

  void emit(const Line &line);
  // G2d: a canvas_texture_* call on RID() (a headless host) -- status unsupported, reason
  // canvas-texture-headless, no id. Caller holds the mutex.
  void null_canvas_texture(Line *line);
  Entry *find(std::uint64_t rid);

  // G5a: one mesh's registry entry. `surfaces` holds every surface's current classification and
  // descriptive fields (the caller -- hooks.cpp -- owns the retained whole-buffer bytes needed to
  // re-hash after a region update, exactly as it owns an image's bytes for a texture update).
  struct MeshEntry {
    std::uint64_t id = 0;
    std::uint64_t version = 1;
    std::string status = "ok";
    std::string reason;
    std::vector<MeshSurfaceCopy> surfaces;
  };
  MeshEntry *find_mesh(std::uint64_t rid);
  // Recomputes `status`/`reason` from the surfaces' own classification: unsupported (the first
  // refused surface's reason) if any, else ok.
  void recompute_mesh_status(MeshEntry *entry);

  mutable std::mutex mutex_;
  bool active_ = false;
  std::uint64_t t0_ns_ = 0;
  std::uint64_t root_viewport_ = 0;
  std::uint64_t next_id_ = 1;
  std::map<std::uint64_t, Entry> by_rid_;
  std::uint64_t next_mesh_id_ = 1;
  std::map<std::uint64_t, MeshEntry> mesh_by_rid_;
  std::string pending_;
  std::uint64_t update_unknown_ = 0;
};

// The process-wide log the hooks write and entry.cpp drains.
ResourceLog &resource_log();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_RESOURCE_LOG_H
