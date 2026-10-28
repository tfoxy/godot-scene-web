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
// drop-resource pin line carries "sabotage":true. G7n (gate7-design.md Q3): an http-get line
// for a CORS preflight ends with "method":"OPTIONS", the only line that carries `method` (a GET
// line is unchanged), so a host's preflights are counted from its hook log. G8kz: when the host
// offers a content coding (GRC_HTTP_ENCODING), a 200 http-get line ends with "coding"
// ("identity", "zstd" or "gzip") and "coded_bytes" (the Content-Length that crossed the wire;
// `payload_bytes` stays the identity size).
//
// G55a (gate5_5-design.md Q3d) adds `kind: "shader"` lines (shader_create, shader_create_from_
// code, shader_set_code, shader_set_default_texture_parameter, free) and `kind: "material"`
// lines (material_create, material_create_from_shader, material_set_shader, material_set_param,
// free), each with its own per-session id counter (D5), and `kind: "item-material"` lines for
// the four item/canvas taps with no mirror field yet (canvas_item_set_use_parent_material,
// canvas_item_set_instance_shader_parameter, canvas_set_modulate, canvas_light_attach_to_canvas).
// As G5a did for meshes, there is no shader or material mirror table yet (that is G55d), so this
// module keeps its own minimal registries -- RID -> wire id, version, status/reason and, for a
// shader, its D7/D11 classification -- reusing the generic `target`/`ref_id` columns for a
// material's current shader (the raw RID and, when known, its wire id) exactly as `texture_
// replace` already reuses them for a texture's "by" argument, and the generic `value` column for
// a plain bool/int state value (`canvas_item_set_use_parent_material`'s enable,
// `shader_set_default_texture_parameter`'s sampler index). New trailing columns: `mode`,
// `source` ("payload" | null: G55a never withholds or excludes, so `source` is "payload" exactly
// when a shader has code and null otherwise), `builtin`, `uses`, `scan_ns` (shader only), and
// `param`, `type`, `n`, `decode_ns` (a decoded StringName/Variant: material_set_param,
// canvas_item_set_instance_shader_parameter and, for the parameter's own name only, shader_set_
// default_texture_parameter). `outcome` on a material/item-material param line is "applied" (a
// supported type, including NIL erasing a parameter), "rejected" (an OBJECT value, D6) or
// "unknown" (any other unsupported type, including an out-of-range int). Names, values and code
// never reach counters.json (Q2) -- only this log and, for canvas_set_modulate's colour and
// canvas_item_set_use_parent_material's bool, the hook's own counters.json capture entry (not a
// material parameter, so Q2's rule does not cover it). A material's `status` here reflects only
// whether its shader RID is one this registry knows (D16 `unknown-shader`); it is never
// recomputed from historical parameter values the way the future mirror will (D6) -- this log is
// evidence for the census, never the stream.
//
// G5a (gate5-design.md Q3d) adds mesh lines, `kind: "mesh"`: one per mesh-related
// RenderingServer call (mesh_create, mesh_create_from_surfaces, mesh_add_surface, the four region
// updates, mesh_surface_remove, mesh_clear, mesh_set_custom_aabb, free). Independently of the
// mirror's mesh table (G5e, rs_mirror.h: the checker compares the two, `mesh-versions-current`),
// this module keeps its own minimal mesh registry too -- RID -> wire
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
//
// G6k (gate6-design.md Q2, calibrator 9) adds `kind: "canvas"` lines for the six new hooks:
// viewport_remove_canvas, viewport_set_global_canvas_transform, viewport_set_canvas_stacking,
// canvas_set_item_mirroring, canvas_set_item_repeat and canvas_set_parent. This module keeps no
// canvas registry of its own (no id/version: a canvas's identity and state are the mirror's
// field, G6b); every line is presence-only, decoded straight off the call's own arguments, as
// G55a's item-material lines are. `rid` is the call's primary RID (the canvas for every op
// except viewport_set_global_canvas_transform, where there is no canvas argument and `rid` is
// the viewport instead, and canvas_set_item_repeat, whose only RID argument is the item);
// `target` is a second RID the call names (the viewport for the two viewport_* taps, the item
// for canvas_set_item_mirroring). New trailing columns, present (null unless relevant) on every
// line: `sublayer` (viewport_set_canvas_stacking's sublayer; its layer reuses the existing
// `layer` column), `transform` (viewport_set_global_canvas_transform's Transform2D, flattened
// column-major: [a, b, c, d, origin.x, origin.y], as canvas_item_add_set_transform's counters.json
// entry already is), `parent` (canvas_set_parent's parent RID, decimal string, or null for
// `RID()`; its scale argument is not logged -- this log is evidence, not the wire, and D2's "no
// classification yet" rule leaves the sticky canvas-follow-viewport/canvas-repeat typing to G6b),
// `mirroring` (canvas_set_item_mirroring's Point2, `[x, y]`) and `repeat` (canvas_set_item_repeat's
// Point2 and int flattened to `[size.x, size.y, times]`). No status/reason/outcome: unlike G55a's
// item-material lines, G6k types no refusal (there is nothing yet to refuse against -- that is
// G6b's mirror).
//
// PM1 (render-stream-11.md "As built (PM1): decisions" rule 12) adds `kind: "multimesh"` lines,
// with a shape of their own (no texture/mesh columns; keys in this order):
//   frame, t_us, thread, kind ("multimesh"), call, rid (decimal string or null), id (the
//   multimesh's wire id, or null when the mirror does not know the RID), accepted (the mirror's
//   GLES3 verdict: false for a refused call or an unknown RID), version (after the call, or
//   null), then the call's own arguments (MultimeshArgs below), and "omitted":true last on a call
//   the omit-op sabotage kept from the mirror.
// `call` is the RenderingServer method name (multimesh_create, multimesh_allocate_data, ...,
// free) for one hooked call, or "state": one line per multimesh per published frame in which its
// version moved, written at publication with the snapshot's frame, carrying version, instances,
// format ("2d" | "3d"), colors, custom, visible, mesh (wire id or null), status, reason and
// buffer_sha256 (the SHA-256 of the mirror's shadow buffer as little-endian f32, null unless the
// status is "ok": exactly the resolved form's rule). This log keeps no multimesh registry of its
// own: the mirror's verdicts are the evidence, and `state` is what the wire must carry.
//
// PM5 (render-stream-12.md "Hook log and counters") adds `kind: "particles"` lines in the same
// shape as the multimesh lines: frame, t_us, thread, kind ("particles"), call (the RenderingServer
// method name, `free` for a free of an emitter), rid, id, accepted, version, then the call's own
// arguments under their header names (a transform as 12 floats in the wire order, an AABB as 6, a
// vector as 3, a colour as 4, a RID as its wire id under the argument's name plus "<arg>_rid",
// doubles as the float32-rounded value the wire carries); particles_emit adds `restarts` last.
// `call: "state"`: one line per emitter per published frame in which its version moved: status,
// reason, version, mode, emitting, amount, one_shot, fixed_fps, interpolate, fractional_delta,
// local, draw_order, transform_align, trails, trail_poses, seed, restarts, emits,
// process_requests, process_material, draw_passes, subemitter, then `floats` (31 + 12 x
// trail_poses floats in wire order, null when freed); rid is null once freed.
#ifndef GRC_RS_RESOURCE_LOG_H
#define GRC_RS_RESOURCE_LOG_H

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
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
  // G8t (gate8-design.md D8): a host decode. `source_format` is the Image::Format the payload was
  // decoded from (-1 unless the copy is an ok decode; `format` is then the payload's); `decode_ns`
  // the seam's duplicate + decompress time, also on a decode that was tried and refused.
  std::int64_t source_format = -1;
  std::int64_t decode_ns = -1;
  // G8kw (rs_texture_worker.h): set on a copy a texture worker made. `copy_ns`/`hash_ns`/`decode_ns`
  // are then the worker's times; `hook_ns` is the hook's own time on the calling thread (facts,
  // prediction, duplicate, hand-off, mirror) and `dup_ns` the copy-on-write duplicate within it.
  // Logged as trailing keys only on such a line, so a synchronous log is unchanged.
  bool worker = false;
  std::int64_t hook_ns = -1;
  std::int64_t dup_ns = -1;
  // G8kp (rs_texture_delivery.h, texture-delivery-design.md D1 `passthrough`): beside an ok host
  // decode at /9, the hooked block bytes as a GRT1 payload in their own format (the `block`
  // variant). Empty hash and null bytes otherwise. Never logged, never part of a prediction's
  // facts: a worker fills them with the content (TextureJob::fill).
  std::string block_hash;
  std::string block_format;
  std::int64_t block_payload_bytes = 0;
  std::shared_ptr<const std::vector<std::uint8_t>> block_bytes;
  // G8kc (rs_texture_cache.h, texture-delivery-design.md D7/D8): with GRC_TEXTURE_CACHE_DIR set,
  // the D7 source key (SHA-256 of the hooked image as GRT1 in its own format) and what the cache
  // made of the derivation: "hit" (the decoded payload came from a verified file), "miss"
  // (derived, then stored), "corrupt" (a file failed verify-against-name, deleted and derived
  // again), "source" (nothing to derive: the payload is the source itself) or "uncached" (the
  // cache was bypassed). Empty when the cache is off. Never logged to resources.jsonl.
  std::string source_key;
  std::string cache_outcome;
};

class TextureJob;  // rs_texture_worker.h

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

// What the hook read, copied and classified from a shader_create_from_code / shader_set_code
// call (gate5_5-design.md D7, D11, Q3a). A D11 reason never refuses the copy itself (the shader
// stays `status`:"ok" with that `reason`'s semantics carried in `mode`/`uses` only) -- only
// `payload-too-large`/`payload-unavailable` leave `hash` empty. `code_bytes` is the decoded
// UTF-8 length.
struct ShaderCopy {
  std::string status = "unsupported";  // "ok" | "unsupported"
  std::string reason;                  // "" when ok; a D11 reason, payload-too-large,
                                       // payload-unavailable
  std::string mode;                    // the first `shader_type <id>;`'s id, "" when none found
  std::vector<std::string> uses;       // D11's informational categories
  bool builtin = false;                // D7: CanvasItemMaterial-recognized
  std::string builtin_blend_mode;      // valid iff builtin
  std::string builtin_light_mode;      // valid iff builtin
  bool builtin_particles_animation = false;
  std::int64_t code_bytes = 0;
  std::string hash;  // the GRP1 payload's SHA-256, empty unless a payload was built
  std::int64_t payload_bytes = 0;
  std::int64_t copy_ns = -1;
  std::int64_t hash_ns = -1;
  std::int64_t scan_ns = -1;
};

// What the hook decoded from a material_set_param / canvas_item_set_instance_shader_parameter
// call's Variant value (gate5_5-design.md D8, Q3a).
// PM1: a multimesh hook line's own arguments, appended as `,"key":value` pairs in call order.
class MultimeshArgs {
 public:
  MultimeshArgs &i64(const char *key, std::int64_t value);
  MultimeshArgs &boolean(const char *key, bool value);
  MultimeshArgs &rid(const char *key, std::uint64_t value);   // decimal string, null for 0
  MultimeshArgs &id(const char *key, std::uint64_t value);    // integer, null for 0
  MultimeshArgs &floats(const char *key, const float *values, std::size_t n);  // non-finite: null
  MultimeshArgs &f32(const char *key, float value);         // PM5: one float, a number (or null)
  MultimeshArgs &str(const char *key, const char *value);   // PM5: a JSON string (null for null)
  MultimeshArgs &raw(const char *key, const std::string &json);  // PM5: preformatted JSON
  // `count` floats from `data`: "<key>": count and "<sha_key>": their SHA-256 (LE f32 bytes).
  MultimeshArgs &buffer(const char *key, const char *sha_key, const float *data,
                        std::size_t count);
  const std::string &text() const { return text_; }

 private:
  std::string text_;
};

// PM1: one `state` line's values (rs_mirror.h MultimeshStateNote, in plain form).
struct MultimeshState {
  std::uint64_t frame = 0;
  std::uint64_t rid = 0;  // 0: freed (null)
  std::uint64_t id = 0;
  std::uint64_t version = 0;
  std::int64_t instances = 0;
  const char *format = "2d";
  bool colors = false;
  bool custom = false;
  std::int64_t visible = -1;
  std::uint64_t mesh = 0;  // 0: null
  const char *status = "ok";
  const char *reason = nullptr;  // null
  const std::vector<float> *buffer = nullptr;  // hashed when status is "ok"
};

struct MaterialParamCopy {
  std::string type;                  // rs::DecodedParam::type
  std::int64_t n = 0;
  std::string outcome = "applied";  // "applied" | "rejected" | "unknown"
  std::int64_t decode_ns = -1;
};

class ResourceLog {
 public:
  // Starts a fresh session: ids restart at 1, the registry empties, buffered
  // lines are dropped. `t0_ns` is the origin of every line's t_us.
  // HC1: `keep_lines` false (GRC_HOOK_LOG=off, or no file to write) makes the log a registry only:
  // every hook still updates its entries (ids, versions, hashes) exactly as before, but no line is
  // formatted, held or buffered, since nothing would read it (take_lines() is then always empty).
  void start(std::uint64_t t0_ns, std::uint64_t root_viewport_rid, bool keep_lines = true);
  void stop();
  bool active() const;
  // True while lines are kept (lock-free): a caller that builds an argument only for a line (the
  // multimesh buffer digest) skips it when this is false.
  bool wants_lines() const { return keep_lines_.load(std::memory_order_relaxed); }
  // HC1 `hook-log-off-formats-nothing`: lines formatted since start() (counters.json).
  std::uint64_t lines_formatted() const { return formatted_.load(std::memory_order_relaxed); }

  // `omitted` (G2b2): the omit-op sabotage dropped this call from the capture.
  // The line is still written, marked "sabotage":true,"omitted":true, with the
  // registry's unchanged id and version, and the registry is not changed, so
  // it keeps agreeing with the mirror (which dropped the call too).
  // G8kw: with a `job` (rs_texture_worker.h) the copy is the hook's prediction; the line, and
  // every line logged after it, is held until the job delivers the hash (take_lines()).
  void texture_2d_create(const TapContext &ctx, std::uint64_t rid, const PayloadCopy &copy,
                         bool omitted = false, std::shared_ptr<TextureJob> job = nullptr);
  void texture_2d_update(const TapContext &ctx, std::uint64_t rid, const PayloadCopy &copy,
                         int layer, bool omitted = false, std::shared_ptr<TextureJob> job = nullptr);
  void texture_2d_placeholder_create(const TapContext &ctx, std::uint64_t rid,
                                     bool omitted = false);
  // G8r (gate8-design.md D6, D7): op "adopt", kind "image": a texture that existed before arm,
  // registered at its first reference exactly as texture_2d_create registers one (a new id,
  // version 1, status from the copy). The line ends with the trailing keys `adopted_content`
  // ("current" | "creation") and `adopt_source` ("textserver", "cache", "dummy" or "update":
  // where the bytes were read), present on adopt lines only.
  void texture_adopt(const TapContext &ctx, std::uint64_t rid, const PayloadCopy &copy,
                     const char *content, const char *source,
                     std::shared_ptr<TextureJob> job = nullptr);
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
                   std::int64_t http_status, bool sabotage, const char *method = nullptr,
                   const char *coding = nullptr, std::uint64_t coded_bytes = 0);
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
  // found), but every surface's bytes are still kept so later region updates still line up. With
  // exactly one surface the line carries it as a mesh_add_surface line does (G5c).
  void mesh_create_from_surfaces(const TapContext &ctx, std::uint64_t rid,
                                 const std::vector<MeshSurfaceCopy> &surfaces,
                                 bool omitted = false);
  // mesh_add_surface: appended at the next index, version + 1; a refused surface makes the entry
  // unsupported (the surface is still kept, so later indices still line up).
  void mesh_add_surface(const TapContext &ctx, std::uint64_t rid, const MeshSurfaceCopy &surface,
                        bool omitted = false);
  // G8r (gate8-design.md D6): op "adopt", kind "mesh": a pre-arm mesh read back through
  // mesh_get_surface, registered as mesh_create_from_surfaces registers one (its single surface
  // on the line, as G5c's), with `adopted_content` "creation" and `adopt_source` "dummy".
  void mesh_adopt(const TapContext &ctx, std::uint64_t rid,
                  const std::vector<MeshSurfaceCopy> &surfaces);
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

  // --- shaders and materials (gate5_5-design.md Q3d, G55a) -------------------
  //
  // shader_create: a new id, ok, version 1, no code yet.
  void shader_create(const TapContext &ctx, std::uint64_t rid, bool omitted = false);
  // shader_create_from_code: a new id, version 1, code classified (`copy`).
  void shader_create_from_code(const TapContext &ctx, std::uint64_t rid, const ShaderCopy &copy,
                               bool omitted = false);
  // shader_set_code: the existing id, version + 1, new classification. An unknown shader RID is
  // logged with a null id and changes nothing (as an unknown texture's update, Q3).
  void shader_set_code(const TapContext &ctx, std::uint64_t rid, const ShaderCopy &copy,
                       bool omitted = false);
  // shader_set_default_texture_parameter: the existing shader's version + 1; unknown as above.
  // `name` is the decoded parameter name (`param`); `texture` is resolved against this log's own
  // texture registry for `ref_id` when known.
  void shader_set_default_texture_parameter(const TapContext &ctx, std::uint64_t shader,
                                            const std::string &name, std::uint64_t texture,
                                            std::int32_t index, bool omitted = false);
  // material_create: a new id, ok, version 1, no shader.
  void material_create(const TapContext &ctx, std::uint64_t rid, bool omitted = false);
  // material_create_from_shader: a new id, version 1, shader set (an unknown shader RID makes
  // the entry `unsupported`/`unknown-shader`, D16).
  void material_create_from_shader(const TapContext &ctx, std::uint64_t rid, std::uint64_t shader,
                                   bool omitted = false);
  // material_set_shader: the existing material's version + 1, shader set or cleared (RID()).
  void material_set_shader(const TapContext &ctx, std::uint64_t material, std::uint64_t shader,
                           bool omitted = false);
  // material_set_param: the existing material's version + 1 unless `copy.outcome` is "rejected"
  // (an OBJECT value, D6 "no change"); `name` is the decoded parameter name, never carried
  // anywhere but this line (Q2).
  void material_set_param(const TapContext &ctx, std::uint64_t material, const std::string &name,
                          const MaterialParamCopy &copy, bool omitted = false);

  // --- item and canvas material state: no mirror field yet (G55d), so these are presence-only
  // lines; the StringName/Variant content of an instance parameter is on this line alone. -------
  //
  // canvas_item_set_material (slot 488, hooked since calibrator 2): logged for the material
  // census (Q3d) alongside calibrator 8's own taps; the item field on the wire/mirror stays
  // G55d's (D2, D9). Touches neither registry: a material naming no entry here is not an error,
  // since this log keeps no notion of "known" for an item field.
  void canvas_item_set_material(const TapContext &ctx, std::uint64_t item, std::uint64_t material);
  void canvas_item_set_use_parent_material(const TapContext &ctx, std::uint64_t item, bool enable);
  void canvas_item_set_instance_shader_parameter(const TapContext &ctx, std::uint64_t item,
                                                 const std::string &name,
                                                 const MaterialParamCopy &copy);
  void canvas_set_modulate(const TapContext &ctx, std::uint64_t canvas);
  void canvas_light_attach_to_canvas(const TapContext &ctx, std::uint64_t light,
                                     std::uint64_t canvas);

  // --- canvases (gate6-design.md Q2, G6k, calibrator 9): decode and log only, no registry, no
  // classification (that is G6b's mirror). `transform`/`mirroring`/`repeat_size` point at 6/2/2
  // contiguous floats (a caller-owned Transform2D/Point2, valid only for the duration of the
  // call; the method reads and copies, never retains the pointer). -----------------------------
  //
  void viewport_remove_canvas(const TapContext &ctx, std::uint64_t viewport,
                              std::uint64_t canvas);
  void viewport_set_global_canvas_transform(const TapContext &ctx, std::uint64_t viewport,
                                            const float *transform);
  void viewport_set_canvas_stacking(const TapContext &ctx, std::uint64_t viewport,
                                    std::uint64_t canvas, std::int32_t layer,
                                    std::int32_t sublayer);
  void canvas_set_item_mirroring(const TapContext &ctx, std::uint64_t canvas, std::uint64_t item,
                                 const float *mirroring);
  void canvas_set_item_repeat(const TapContext &ctx, std::uint64_t item,
                              const float *repeat_size, std::int32_t repeat_times);
  // `scale` is not logged (see the header comment above); only `parent`'s presence matters here.
  void canvas_set_parent(const TapContext &ctx, std::uint64_t canvas, std::uint64_t parent);

  // PM1 (rule 12): one hooked multimesh call (`call` its method name), and one `state` line.
  void multimesh_call(const TapContext &ctx, const char *call, std::uint64_t rid,
                      std::uint64_t id, bool accepted, std::uint64_t version,
                      const MultimeshArgs &args, bool omitted = false);
  void multimesh_state(const TapContext &ctx, const MultimeshState &state);
  // PM5: one hooked particles call, and one `state` line (`entry_json` is the entry's JSON fields
  // from "status" on, without braces, as particles_state_fields() writes them).
  void particles_call(const TapContext &ctx, const char *call, std::uint64_t rid,
                      std::uint64_t id, bool accepted, std::uint64_t version,
                      const MultimeshArgs &args, bool omitted = false);
  void particles_state(const TapContext &ctx, std::uint64_t frame, std::uint64_t rid,
                       std::uint64_t id, const std::string &entry_json);

  // The wire id of a texture RID the log knows, or 0.
  std::uint64_t texture_id(std::uint64_t rid) const;
  // The wire id of a mesh RID the log knows, or 0.
  std::uint64_t mesh_id(std::uint64_t rid) const;
  // The wire id of a shader RID the log knows, or 0.
  std::uint64_t shader_id(std::uint64_t rid) const;
  // The wire id of a material RID the log knows, or 0.
  std::uint64_t material_id(std::uint64_t rid) const;

  // Takes every line buffered since the last call ("" when none), each ending
  // in '\n'. G8kw: stops before the first line still waiting for a texture worker's hash.
  std::string take_lines();
  // Lines held for a texture worker (G8kw), 0 when synchronous.
  std::size_t deferred_lines() const;

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
    std::shared_ptr<TextureJob> job;  // G8kw: delivers payload.hash (null once settled)
    std::int32_t filter = 0;  // kind canvas
    std::int32_t repeat = 0;
    std::map<std::int32_t, std::uint64_t> channels;
  };

  // Formats `line` into the buffer, or (G8kw) holds it behind a pending `job` or behind an
  // earlier held line. Caller holds the mutex.
  void emit(const Line &line, const std::shared_ptr<TextureJob> &job = nullptr);
  void emit_text(const std::string &text);  // PM1: a preformatted line, in log order
  void format(std::string *out, const Line &line) const;
  // G8kw: a finished job's hash moves into the registry entry. Caller holds the mutex.
  static void settle(Entry *entry);
  struct Deferred;  // a held line (rs_resource_log.cpp)
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

  // G55a: one shader's registry entry (gate5_5-design.md Q3d). No code is retained (only the
  // classification derived from it): a payload is never read back from this log.
  struct ShaderEntry {
    std::uint64_t id = 0;
    std::uint64_t version = 1;
    std::string status = "ok";
    std::string reason;
    std::string mode;
    std::vector<std::string> uses;
    bool builtin = false;
    std::string builtin_blend_mode;
    std::string builtin_light_mode;
    bool builtin_particles_animation = false;
    std::string hash;
    std::int64_t payload_bytes = 0;
  };
  ShaderEntry *find_shader(std::uint64_t rid);
  // Copies every ShaderCopy field into the registry entry (shader_create_from_code's initial
  // write and shader_set_code's update share this).
  void copy_shader_fields(ShaderEntry *entry, const ShaderCopy &copy);

  // G55a: one material's registry entry. `shader_rid` is the raw RID named by the last
  // material_create_from_shader/material_set_shader (0 = none); `status` reflects only whether
  // that RID is a shader this registry knows (D16 `unknown-shader`), never a parameter's own
  // type (Q3d's header comment).
  struct MaterialEntry {
    std::uint64_t id = 0;
    std::uint64_t version = 1;
    std::string status = "ok";
    std::string reason;
    std::uint64_t shader_rid = 0;
  };
  MaterialEntry *find_material(std::uint64_t rid);
  // Recomputes `status`/`reason` from `shader_rid` alone.
  void recompute_material_status(MaterialEntry *entry);

  mutable std::mutex mutex_;
  bool active_ = false;
  std::uint64_t t0_ns_ = 0;
  std::uint64_t root_viewport_ = 0;
  std::uint64_t next_id_ = 1;
  std::map<std::uint64_t, Entry> by_rid_;
  std::uint64_t next_mesh_id_ = 1;
  std::map<std::uint64_t, MeshEntry> mesh_by_rid_;
  std::uint64_t next_shader_id_ = 1;
  std::map<std::uint64_t, ShaderEntry> shader_by_rid_;
  std::uint64_t next_material_id_ = 1;
  std::map<std::uint64_t, MaterialEntry> material_by_rid_;
  std::atomic<bool> keep_lines_{true};
  mutable std::atomic<std::uint64_t> formatted_{0};
  std::string pending_;
  std::vector<std::shared_ptr<Deferred>> deferred_;  // G8kw, in log order
  std::uint64_t update_unknown_ = 0;
};

// The process-wide log the hooks write and entry.cpp drains.
ResourceLog &resource_log();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_RESOURCE_LOG_H
