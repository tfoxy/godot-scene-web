#include "hooks.h"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <type_traits>

#include "abi.h"
#include "iface.h"
#include "report.h"
#include "rs_canvas_texture_shim.h"
#include "rs_mesh_payload.h"
#include "rs_mirror.h"
#include "rs_resource_log.h"
#include "rs_sha256.h"
#include "rs_shader_payload.h"
#include "rs_texture_decode.h"
#include "rs_texture_cache.h"
#include "rs_texture_delivery.h"
#include "rs_texture_payload.h"
#include "rs_texture_worker.h"
#include "rs_variant.h"

namespace grc {

namespace {

// Exact 4.5.1 signatures from servers/rendering_server.h, with the implicit
// `this` made explicit. A wrong signature would corrupt arguments, so each one
// names its source line. Default arguments do not exist at the ABI level; enums
// are passed as their 4-byte underlying integer; `const T &` is a pointer.
//
// --- gate -1 (required) ------------------------------------------------------
//
//   1581: virtual void canvas_item_add_rect(RID, const Rect2 &, const Color &, bool) = 0;
using FnAddRect = void (*)(void *, RID, const Rect2 *, const Color *, bool);
//   1583: virtual void canvas_item_add_texture_rect(RID, const Rect2 &, RID, bool,
//                                                   const Color &, bool) = 0;
using FnAddTextureRect = void (*)(void *, RID, const Rect2 *, RID, bool, const Color *, bool);
//   1584: virtual void canvas_item_add_texture_rect_region(RID, const Rect2 &, RID,
//                                                          const Rect2 &, const Color &, bool,
//                                                          bool) = 0;
using FnAddTextureRectRegion = void (*)(void *, RID, const Rect2 *, RID, const Rect2 *,
                                        const Color *, bool, bool);
//   1585: virtual void canvas_item_add_msdf_texture_rect_region(RID, const Rect2 &, RID,
//                                                               const Rect2 &, const Color &,
//                                                               int, float, float) = 0;
using FnAddMsdfTextureRectRegion = void (*)(void *, RID, const Rect2 *, RID, const Rect2 *,
                                            const Color *, int, float, float);
//   1589: virtual void canvas_item_add_polygon(RID, const Vector<Point2> &, const Vector<Color> &,
//                                              const Vector<Point2> &, RID) = 0;
using FnAddPolygon = void (*)(void *, RID, const Vector<Point2> *, const Vector<Color> *,
                              const Vector<Point2> *, RID);
//   136: virtual RID texture_2d_create(const Ref<Image> &) = 0;
using FnTexture2dCreate = RID (*)(void *, const Ref *);
//   144: virtual void texture_2d_update(RID, const Ref<Image> &, int) = 0;
using FnTexture2dUpdate = void (*)(void *, RID, const Ref *, int);
//   161: virtual void texture_set_path(RID p_texture, const String &p_path) = 0;
//   (G8kc, calibrator 10: the engine calls it after texture_2d_create with the res:// path,
//   compressed_texture.cpp:91-96, :158-161; installed only under GRC_TEXTURE_CACHE_DIR)
using FnTextureSetPath = void (*)(void *, RID, const void *);
//   virtual void canvas_item_set_canvas_group_mode(RID p_item, CanvasGroupMode p_mode,
//       float p_clear_margin = 5.0, bool p_fit_empty = false, float p_fit_margin = 0.0,
//       bool p_blur_mipmaps = false) = 0;
//   (CG1, slot 495, render-stream-10.md "Capture": installed only under GRC_STREAM_VERSION=10;
//   canvas_item_set_copy_to_backbuffer, slot 484, is FnSetCustomRect's shape)
using FnSetCanvasGroupMode = void (*)(void *, RID, int32_t, float, bool, float, bool);
//   1770: virtual void free(RID) = 0;
using FnFree = void (*)(void *, RID);
//
// --- after gate -1 (optional) ------------------------------------------------
//
//   1590: virtual void canvas_item_add_triangle_array(RID, const Vector<int> &,
//             const Vector<Point2> &, const Vector<Color> &, const Vector<Point2> &,
//             const Vector<int> &, const Vector<float> &, RID, int) = 0;
using FnAddTriangleArray = void (*)(void *, RID, const Vector<int32_t> *, const Vector<Point2> *,
                                    const Vector<Color> *, const Vector<Point2> *,
                                    const Vector<int32_t> *, const Vector<float> *, RID, int);
//   1591: virtual void canvas_item_add_mesh(RID, const RID &, const Transform2D &, const Color &,
//                                           RID) = 0;   (the mesh RID is by REFERENCE)
using FnAddMesh = void (*)(void *, RID, const RID *, const Transform2D *, const Color *, RID);
//   1592: virtual void canvas_item_add_multimesh(RID, RID, RID) = 0;
using FnAddMultimesh = void (*)(void *, RID, RID, RID);
//   1587: virtual void canvas_item_add_nine_patch(RID, const Rect2 &, const Rect2 &, RID,
//             const Vector2 &, const Vector2 &, NinePatchAxisMode, NinePatchAxisMode, bool,
//             const Color &) = 0;
using FnAddNinePatch = void (*)(void *, RID, const Rect2 *, const Rect2 *, RID, const Vector2 *,
                                const Vector2 *, int32_t, int32_t, bool, const Color *);
//   1588: virtual void canvas_item_add_primitive(RID, const Vector<Point2> &,
//             const Vector<Color> &, const Vector<Point2> &, RID) = 0;
using FnAddPrimitive = void (*)(void *, RID, const Vector<Point2> *, const Vector<Color> *,
                                const Vector<Point2> *, RID);
//   1578: virtual void canvas_item_add_line(RID, const Point2 &, const Point2 &, const Color &,
//                                           float, bool) = 0;
using FnAddLine = void (*)(void *, RID, const Point2 *, const Point2 *, const Color *, float, bool);
//   1579: virtual void canvas_item_add_polyline(RID, const Vector<Point2> &,
//                                               const Vector<Color> &, float, bool) = 0;
using FnAddPolyline = void (*)(void *, RID, const Vector<Point2> *, const Vector<Color> *, float,
                               bool);
//   1582: virtual void canvas_item_add_circle(RID, const Point2 &, float, const Color &,
//                                             bool) = 0;
using FnAddCircle = void (*)(void *, RID, const Point2 *, float, const Color *, bool);
//   1594: virtual void canvas_item_add_set_transform(RID, const Transform2D &) = 0;
//   1561: virtual void canvas_item_set_transform(RID, const Transform2D &) = 0;
using FnItemTransform = void (*)(void *, RID, const Transform2D *);
//   1565: virtual void canvas_item_set_modulate(RID, const Color &) = 0;
//   1566: virtual void canvas_item_set_self_modulate(RID, const Color &) = 0;
using FnSetModulate = void (*)(void *, RID, const Color *);
//   1550: virtual RID canvas_item_create() = 0;
//    397: virtual RID mesh_create() = 0;
//   1525: virtual RID canvas_create() = 0;
using FnCreate = RID (*)(void *);
//   1605: virtual void canvas_item_clear(RID) = 0;
//    450: virtual void mesh_clear(RID) = 0;
using FnRidOnly = void (*)(void *, RID);
//   1608: virtual void canvas_item_set_material(RID, RID) = 0;
//   1031: virtual void viewport_attach_canvas(RID p_viewport, RID p_canvas) = 0;
//   1551: virtual void canvas_item_set_parent(RID p_item, RID p_parent) = 0;
using FnSetMaterial = void (*)(void *, RID, RID);
//    417: virtual void mesh_add_surface(RID, const SurfaceData &) = 0;
using FnMeshAddSurface = void (*)(void *, RID, const SurfaceDataPrefix *);
//    429: virtual void mesh_surface_update_vertex_region(RID, int, int, const Vector<uint8_t> &) = 0;
//    430: virtual void mesh_surface_update_attribute_region(RID, int, int,
//                                                          const Vector<uint8_t> &) = 0;
using FnMeshUpdateRegion = void (*)(void *, RID, int, int, const Vector<uint8_t> *);
//    441: virtual void mesh_set_custom_aabb(RID, const AABB &) = 0;
using FnMeshSetCustomAabb = void (*)(void *, RID, const AABB *);
//    231: virtual RID shader_create_from_code(const String &, const String &) = 0;
//         (Strings not decoded)
using FnShaderCreateFromCode = RID (*)(void *, const void *, const void *);
//    233: virtual void shader_set_code(RID, const String &) = 0;   (String not decoded)
using FnShaderSetCode = void (*)(void *, RID, const void *);
//    267: virtual void material_set_param(RID, const StringName &, const Variant &) = 0;
//         (StringName and Variant not decoded)
using FnMaterialSetParam = void (*)(void *, RID, const void *, const void *);
//
// --- calibrator 3 (optional): gate 0's retained canvas mirror -----------------
//
//   1033: virtual void viewport_set_canvas_transform(RID p_viewport, RID p_canvas,
//                                                    const Transform2D &p_offset) = 0;
using FnViewportSetCanvasTransform = void (*)(void *, RID, RID, const Transform2D *);
//   1556: virtual void canvas_item_set_visible(RID p_item, bool p_visible) = 0;
//   1562: virtual void canvas_item_set_clip(RID p_item, bool p_clip) = 0;
//   1569: virtual void canvas_item_set_draw_behind_parent(RID p_item, bool p_enable) = 0;
//   1600: virtual void canvas_item_set_z_as_relative_to_parent(RID p_item, bool p_enable) = 0;
using FnRidBool = void (*)(void *, RID, bool);
//   1564: virtual void canvas_item_set_custom_rect(RID p_item, bool p_custom_rect,
//                                                  const Rect2 &p_rect = Rect2()) = 0;
using FnSetCustomRect = void (*)(void *, RID, bool, const Rect2 *);
//   1567: virtual void canvas_item_set_visibility_layer(RID p_item,
//                                                       uint32_t p_visibility_layer) = 0;
using FnRidU32 = void (*)(void *, RID, uint32_t);
//   1599: virtual void canvas_item_set_z_index(RID p_item, int p_z) = 0;
//   1606: virtual void canvas_item_set_draw_index(RID p_item, int p_index) = 0;
using FnRidInt = void (*)(void *, RID, int);
//
// --- calibrator 4 (optional): gate1-design.md G1e, the draw-order fields the
// mirror held at RenderingServer defaults until now ---------------------------
//
// --- calibrator 5 (optional): gate2-design.md Q2, textures --------------------
//
//    150: virtual RID texture_2d_placeholder_create() = 0;
//   1534: virtual RID canvas_texture_create() = 0;
//         (FnCreate)
//    158: virtual void texture_replace(RID p_texture, RID p_by_texture) = 0;
//         (FnSetMaterial: two RIDs)
//   1040: virtual void viewport_set_default_canvas_item_texture_filter(RID p_viewport,
//                                                      CanvasItemTextureFilter p_filter) = 0;
//   1041: virtual void viewport_set_default_canvas_item_texture_repeat(RID p_viewport,
//                                                      CanvasItemTextureRepeat p_repeat) = 0;
//   1545: virtual void canvas_texture_set_texture_filter(RID p_canvas_texture,
//                                                        CanvasItemTextureFilter p_filter) = 0;
//   1546: virtual void canvas_texture_set_texture_repeat(RID p_canvas_texture,
//                                                        CanvasItemTextureRepeat p_repeat) = 0;
//   1553: virtual void canvas_item_set_default_texture_filter(RID p_item,
//                                                             CanvasItemTextureFilter p_filter) = 0;
//   1554: virtual void canvas_item_set_default_texture_repeat(RID p_item,
//                                                             CanvasItemTextureRepeat p_repeat) = 0;
using FnRidEnum = void (*)(void *, RID, int32_t);
//   1541: virtual void canvas_texture_set_channel(RID p_canvas_texture,
//                                                 CanvasTextureChannel p_channel, RID p_texture) = 0;
using FnCanvasTextureSetChannel = void (*)(void *, RID, int32_t, RID);
//   1586: virtual void canvas_item_add_lcd_texture_rect_region(RID p_item, const Rect2 &p_rect,
//             RID p_texture, const Rect2 &p_src_rect, const Color &p_modulate = Color(1, 1, 1)) = 0;
using FnAddLcdTextureRectRegion = void (*)(void *, RID, const Rect2 *, RID, const Rect2 *,
                                           const Color *);
//
// --- calibrator 6 (optional): gate3-design.md Q2, clip_ignore (typed until G5d, a /4 command
// since) -----------------------------------------------------------------------------------
//
//   1595: virtual void canvas_item_add_clip_ignore(RID p_item, bool p_ignore) = 0;
//         (FnRidBool: the same ABI as canvas_item_set_clip)
//
// --- calibrator 7 (optional): gate5-design.md Q2, D2 -- two silent holes closed
// (draw_multiline / draw_dashed_line's canvas_item_add_multiline, and a loaded ArrayMesh's
// mesh_create_from_surfaces), typed refusals (particles, animation slice, skeleton attach), and
// the remaining mesh region/removal hooks ---------------------------------------------------
//
//    396: virtual RID mesh_create_from_surfaces(const Vector<SurfaceData> &, int) = 0;
using FnMeshCreateFromSurfaces = RID (*)(void *, const Vector<SurfaceDataPrefix> *, int32_t);
//    431: virtual void mesh_surface_update_skin_region(RID, int, int, const Vector<uint8_t> &) = 0;
//    432: virtual void mesh_surface_update_index_region(RID, int, int, const Vector<uint8_t> &) = 0;
//         (FnMeshUpdateRegion: the same ABI as the vertex/attribute region updates)
//    449: virtual void mesh_surface_remove(RID, int) = 0;
//         (FnRidInt: the same ABI as canvas_item_set_z_index / canvas_item_set_draw_index)
//   1580: virtual void canvas_item_add_multiline(RID, const Vector<Point2> &, const Vector<Color> &,
//             float = -1.0, bool = false) = 0;
//         (FnAddPolyline: the same ABI as canvas_item_add_polyline)
//   1593: virtual void canvas_item_add_particles(RID, RID, RID) = 0;
//         (FnAddMultimesh: the same ABI as canvas_item_add_multimesh)
//   1596: virtual void canvas_item_add_animation_slice(RID, double, double, double, double) = 0;
using FnAddAnimationSlice = void (*)(void *, RID, double, double, double, double);
//   1603: virtual void canvas_item_attach_skeleton(RID, RID) = 0;
//         (FnSetMaterial: the same ABI as canvas_item_set_material)
//
// --- calibrator 8 (optional): gate5_5-design.md Q2, D2 -- materials and canvas shaders: three
// silent holes closed (every material's shader, every CanvasItemMaterial shader, inherited
// materials), a canvas field and two typed refusals -----------------------------------------
//
//    230: virtual RID shader_create() = 0;
//    262: virtual RID material_create() = 0;
//         (FnCreate: the same ABI as mesh_create / canvas_item_create / canvas_create)
//    239: virtual void shader_set_default_texture_parameter(RID, const StringName &, RID,
//                                                           int = 0) = 0;
using FnShaderSetDefaultTextureParameter = void (*)(void *, RID, const void *, RID, int32_t);
//    263: virtual RID material_create_from_shader(RID, int, RID) = 0;
using FnMaterialCreateFromShader = RID (*)(void *, RID, int32_t, RID);
//    265: virtual void material_set_shader(RID, RID) = 0;
//   1645: virtual void canvas_light_attach_to_canvas(RID, RID) = 0;
//         (FnSetMaterial: the same ABI as canvas_item_set_material)
//   1528: virtual void canvas_set_modulate(RID, const Color &) = 0;
//         (FnSetModulate: the same ABI as canvas_item_set_modulate)
//   1610: virtual void canvas_item_set_use_parent_material(RID, bool) = 0;
//         (FnRidBool: the same ABI as canvas_item_set_clip)
//   1612: virtual void canvas_item_set_instance_shader_parameter(RID, const StringName &,
//                                                                const Variant &) = 0;
//         (FnMaterialSetParam: the same ABI as material_set_param)
//
// --- calibrator 9 (optional): gate6-design.md Q2 -- CanvasLayer attach/stacking/removal,
// canvas-item mirroring/repeat and the root's global canvas transform. G6k decoded and hook-logged
// them; since G6b each also taps the mirror (render-stream/6, gate6-design.md Q3b). canvas_set_item_mirroring's REAL ABI takes two RIDs (p_canvas, p_item),
// not the one gate6-design.md's Q2 shorthand describes -- confirmed against
// ../../../godot-4.5.1-stable/servers/rendering_server.h:1526, trusted over the design doc per
// AGENTS.md "Godot References" -----------------------------------------------------------------
//
//   1032: virtual void viewport_remove_canvas(RID p_viewport, RID p_canvas) = 0;
//         (FnSetMaterial: the same ABI as viewport_attach_canvas)
//   1043: virtual void viewport_set_global_canvas_transform(RID, const Transform2D &) = 0;
using FnViewportSetGlobalCanvasTransform = void (*)(void *, RID, const Transform2D *);
//   1044: virtual void viewport_set_canvas_stacking(RID p_viewport, RID p_canvas, int p_layer,
//                                                   int p_sublayer) = 0;
using FnViewportSetCanvasStacking = void (*)(void *, RID, RID, int32_t, int32_t);
//   1526: virtual void canvas_set_item_mirroring(RID p_canvas, RID p_item,
//                                                const Point2 &p_mirroring) = 0;
using FnCanvasSetItemMirroring = void (*)(void *, RID, RID, const Point2 *);
//   1527: virtual void canvas_set_item_repeat(RID p_item, const Point2 &p_repeat_size,
//                                             int p_repeat_times) = 0;
using FnCanvasSetItemRepeat = void (*)(void *, RID, const Point2 *, int32_t);
//   1529: virtual void canvas_set_parent(RID p_canvas, RID p_parent, float p_scale) = 0;
using FnCanvasSetParent = void (*)(void *, RID, RID, float);

// Hook ids. The first eight are the gate -1 set and are required; the rest are
// optional (see hooks.h).
enum HookId : size_t {
  kAddRect,
  kAddTextureRect,
  kAddTextureRectRegion,
  kAddMsdfTextureRectRegion,
  kAddPolygon,
  kTexture2dCreate,
  kTexture2dUpdate,
  kFree,
  kRequiredHookCount,
  kAddTriangleArray = kRequiredHookCount,
  kAddMesh,
  kAddMultimesh,
  kAddNinePatch,
  kAddPrimitive,
  kAddLine,
  kAddPolyline,
  kAddCircle,
  kAddSetTransform,
  kSetTransform,
  kSetModulate,
  kCanvasItemCreate,
  kCanvasItemClear,
  kSetMaterial,
  kMeshCreate,
  kMeshAddSurface,
  kMeshUpdateVertexRegion,
  kMeshUpdateAttributeRegion,
  kMeshClear,
  kMeshSetCustomAabb,
  kShaderCreateFromCode,
  kShaderSetCode,
  kMaterialSetParam,
  // calibrator 3
  kViewportAttachCanvas,
  kViewportSetCanvasTransform,
  kCanvasCreate,
  kSetParent,
  kSetVisible,
  kSetClip,
  kSetCustomRect,
  kSetSelfModulate,
  kSetVisibilityLayer,
  kSetZIndex,
  kSetDrawIndex,
  // calibrator 4
  kSetZAsRelative,
  kSetDrawBehindParent,
  // calibrator 5
  kTexture2dPlaceholderCreate,
  kTextureReplace,
  kViewportSetDefaultTextureFilter,
  kViewportSetDefaultTextureRepeat,
  kCanvasTextureCreate,
  kCanvasTextureSetChannel,
  kCanvasTextureSetTextureFilter,
  kCanvasTextureSetTextureRepeat,
  kSetDefaultTextureFilter,
  kSetDefaultTextureRepeat,
  kAddLcdTextureRectRegion,
  // calibrator 6
  kAddClipIgnore,
  // calibrator 7
  kMeshCreateFromSurfaces,
  kMeshUpdateSkinRegion,
  kMeshUpdateIndexRegion,
  kMeshSurfaceRemove,
  kAddMultiline,
  kAddParticles,
  kAddAnimationSlice,
  kAttachSkeleton,
  // calibrator 8
  kShaderCreate,
  kShaderSetDefaultTextureParameter,
  kMaterialCreate,
  kMaterialCreateFromShader,
  kMaterialSetShader,
  kSetCanvasModulate,
  kSetUseParentMaterial,
  kSetInstanceShaderParameter,
  kCanvasLightAttachToCanvas,
  // calibrator 9
  kViewportRemoveCanvas,
  kViewportSetGlobalCanvasTransform,
  kViewportSetCanvasStacking,
  kCanvasSetItemMirroring,
  kCanvasSetItemRepeat,
  kCanvasSetParent,
  // calibrator 10 (G8kc): conditional, see hooks_plan
  kTextureSetPath,
  // CG1 (render-stream-10.md "Capture", calibrator 9 record slots 484/495): conditional, see
  // hooks_plan
  kSetCopyToBackbuffer,
  kSetCanvasGroupMode,
  kHookCount,
};

void *g_original[kHookCount] = {};
std::atomic<uint64_t> g_count[kHookCount];
bool g_omitted[kHookCount] = {};
size_t g_hooks_total = kHookCount;
bool g_skipped[kHookCount] = {};  // conditional hooks left out by configuration (not omitted)
std::vector<std::string> g_planned_names;
std::vector<std::string> g_omitted_names;

std::atomic<uint64_t> g_frame{1};

template <typename Fn>
Fn original(HookId id) {
  return reinterpret_cast<Fn>(g_original[id]);
}

void bump(HookId id) { g_count[id].fetch_add(1, std::memory_order_relaxed); }

uint64_t current_frame() { return g_frame.load(std::memory_order_relaxed); }

// --- capture storage ---------------------------------------------------------

constexpr size_t kMaxRects = 64;
constexpr size_t kMaxPolygons = 16;
constexpr size_t kMaxTextures = 32;
constexpr size_t kMaxPolygonPoints = 64;
// Distinct entries kept per optional hook, and elements kept per captured array.
constexpr size_t kMaxEntries = 32;
constexpr size_t kMaxElements = 64;
constexpr size_t kMaxRegionBytes = 64;

struct RectCapture {
  uint64_t item;
  Rect2 rect;
  Color color;
  bool antialiased;
};

struct PolygonCapture {
  uint64_t item;
  std::vector<Point2> points;
  int64_t points_total;
  std::vector<Color> colors;
  int64_t colors_total;
  int64_t uvs_count;
  uint64_t texture;
};

struct ImageCapture {
  uint64_t rid;
  uint64_t frame;
  int64_t layer;
  bool details;
  int64_t width;
  int64_t height;
  int64_t format;
  int64_t data_size;
};

// Shared bookkeeping of every deduplicated capture: how often an identical call
// arrived, and in which frames.
struct Seen {
  uint64_t calls = 0;
  uint64_t first_frame = 0;
  uint64_t last_frame = 0;
};

// A plain-data key compared bytewise. Keys are zero-filled before their fields
// are set, so padding never makes two identical calls look different.
template <typename Key>
struct PodEntry {
  static_assert(std::is_trivially_copyable_v<Key>, "PodEntry keys are compared with memcmp");
  Key key;
  Seen seen;
  bool same_as(const PodEntry &other) const {
    return std::memcmp(&key, &other.key, sizeof(Key)) == 0;
  }
};

// Zero-fills a key in place (padding included) before its fields are set.
template <typename Key>
void zero(Key *key) {
  static_assert(std::is_trivially_copyable_v<Key>, "keys are compared with memcmp");
  std::memset(static_cast<void *>(key), 0, sizeof(Key));
}

template <typename Entry>
struct Log {
  std::vector<Entry> entries;
  uint64_t dropped = 0;
  size_t cap = kMaxEntries;  // distinct entries kept
};

// The two texture-rect draws (full capture since calibrator 5) keep more
// distinct entries: a scene redraws them per glyph and per sprite.
constexpr size_t kMaxTextureRectEntries = 256;

std::mutex g_mutex;

// Records `entry` (under g_mutex): bumps an identical entry, or appends a new
// one while there is room, or counts it as dropped.
template <typename Entry>
void log_entry(Log<Entry> *log, Entry entry) {
  const uint64_t frame = current_frame();
  std::lock_guard<std::mutex> lock(g_mutex);
  for (Entry &existing : log->entries) {
    if (existing.same_as(entry)) {
      ++existing.seen.calls;
      existing.seen.last_frame = frame;
      return;
    }
  }
  if (log->entries.size() >= log->cap) {
    ++log->dropped;
    return;
  }
  entry.seen.calls = 1;
  entry.seen.first_frame = frame;
  entry.seen.last_frame = frame;
  log->entries.push_back(std::move(entry));
}

// Copies at most kMaxElements elements of an engine Vector and returns its full size.
template <typename T>
int64_t copy_head(const Vector<T> *vector, std::vector<T> *out) {
  if (vector == nullptr) {
    return 0;
  }
  const int64_t total = vector->size();
  const int64_t limit = total < static_cast<int64_t>(kMaxElements)
                            ? total
                            : static_cast<int64_t>(kMaxElements);
  if (limit > 0) {
    out->assign(vector->ptr(), vector->ptr() + limit);
  }
  return total;
}

template <typename T>
bool same_bits(const std::vector<T> &a, const std::vector<T> &b) {
  return a.size() == b.size() &&
         (a.empty() || std::memcmp(a.data(), b.data(), a.size() * sizeof(T)) == 0);
}

// Array-carrying draws: triangle arrays, primitives and polylines.
struct GeometryEntry {
  uint64_t item = 0;
  std::vector<int32_t> indices;
  int64_t indices_total = 0;
  std::vector<Point2> points;
  int64_t points_total = 0;
  std::vector<Color> colors;
  int64_t colors_total = 0;
  std::vector<Point2> uvs;
  int64_t uvs_total = 0;
  int64_t bones_total = 0;
  int64_t weights_total = 0;
  uint64_t texture = 0;
  int64_t count = 0;
  float width = 0.0f;
  bool antialiased = false;
  Seen seen;

  bool same_as(const GeometryEntry &o) const {
    return item == o.item && indices_total == o.indices_total && points_total == o.points_total &&
           colors_total == o.colors_total && uvs_total == o.uvs_total &&
           bones_total == o.bones_total && weights_total == o.weights_total &&
           texture == o.texture && count == o.count &&
           std::memcmp(&width, &o.width, sizeof(float)) == 0 && antialiased == o.antialiased &&
           same_bits(indices, o.indices) && same_bits(points, o.points) &&
           same_bits(colors, o.colors) && same_bits(uvs, o.uvs);
  }
};

struct NinePatchKey {
  uint64_t item;
  Rect2 rect;
  Rect2 source;
  uint64_t texture;
  Vector2 topleft;
  Vector2 bottomright;
  int32_t x_axis_mode;
  int32_t y_axis_mode;
  Color modulate;
  bool draw_center;
};

struct LineKey {
  uint64_t item;
  Point2 from;
  Point2 to;
  Color color;
  float width;
  bool antialiased;
};

struct CircleKey {
  uint64_t item;
  Point2 position;
  float radius;
  Color color;
  bool antialiased;
};

struct ItemTransformKey {
  uint64_t item;
  Transform2D transform;
};

struct ItemColorKey {
  uint64_t item;
  Color color;
};

struct AddMeshKey {
  uint64_t item;
  uint64_t mesh;
  Transform2D transform;
  Color modulate;
  uint64_t texture;
};

struct RidTripleKey {
  uint64_t a;
  uint64_t b;
  uint64_t c;
};

struct MeshSurfaceKey {
  uint64_t mesh;
  int32_t primitive;
  uint64_t format;
  int64_t vertex_data_size;
  int64_t attribute_data_size;
  int64_t skin_data_size;
  uint32_t vertex_count;
  int64_t index_data_size;
  uint32_t index_count;
  AABB aabb;
};

struct RegionKey {
  uint64_t mesh;
  int32_t surface;
  int32_t offset;
  int64_t data_size;
  uint32_t head_size;
  uint8_t head[kMaxRegionBytes];
};

struct MeshAabbKey {
  uint64_t mesh;
  AABB aabb;
};

// An item and one scalar state value (bool, int or uint32 widened to int64).
struct ItemValueKey {
  uint64_t item;
  int64_t value;
};

struct ItemCustomRectKey {
  uint64_t item;
  bool enabled;
  Rect2 rect;
};

struct ViewportCanvasTransformKey {
  uint64_t viewport;
  uint64_t canvas;
  Transform2D transform;
};

// Calibrator 9 (gate6-design.md Q2): CanvasLayer stacking/attachment and canvas-item
// mirroring/repeat.
struct ViewportTransformKey {
  uint64_t viewport;
  Transform2D transform;
};

struct CanvasStackingKey {
  uint64_t viewport;
  uint64_t canvas;
  int32_t layer;
  int32_t sublayer;
};

struct CanvasItemMirroringKey {
  uint64_t canvas;
  uint64_t item;
  Point2 mirroring;
};

struct CanvasItemRepeatKey {
  uint64_t item;
  Point2 repeat_size;
  int32_t repeat_times;
};

struct CanvasParentKey {
  uint64_t canvas;
  uint64_t parent;
  float scale;
};

// Calibrator 5 (gate2-design.md Q2): the texture-rect draws' full arguments,
// and the new texture hooks' arguments.
struct TextureRectKey {
  uint64_t item;
  Rect2 rect;
  uint64_t texture;
  Color modulate;
  bool tile;
  bool transpose;
};

struct TextureRectRegionKey {
  uint64_t item;
  Rect2 rect;
  uint64_t texture;
  Rect2 source;
  Color modulate;
  bool transpose;
  bool clip_uv;
};

// G4e2 (gate4-design.md Q2): the msdf draw's full arguments, in _texture_rect_region's shape plus
// outline_size, px_range and scale.
struct MsdfRectKey {
  uint64_t item;
  Rect2 rect;
  uint64_t texture;
  Rect2 source;
  Color modulate;
  int32_t outline_size;
  float px_range;
  float scale;
};

struct LcdRectKey {
  uint64_t item;
  Rect2 rect;
  uint64_t texture;
  Rect2 source;
  Color modulate;
};

struct ChannelKey {
  uint64_t canvas_texture;
  int64_t channel;
  uint64_t texture;
};

// Calibrator 7 (gate5-design.md Q2): canvas_item_add_animation_slice's four doubles, narrowed to
// float32 for the capture log -- the op is permanently typed unsupported (D16), so nothing needs
// it bit-exact.
struct AnimationSliceKey {
  uint64_t item;
  float animation_length;
  float slice_begin;
  float slice_end;
  float offset;
};

// Calibrator 8 (gate5_5-design.md Q2): the two new multi-field identities. Neither carries the
// decoded name/value counters.json must never show (Q2) -- only the RIDs and plain scalars every
// other optional hook's capture log already carries.
struct ShaderDefaultTextureKey {
  uint64_t shader;
  uint64_t texture;
  int32_t index;
};

struct MaterialShaderKey {
  uint64_t material;
  uint64_t shader;
};

std::vector<RectCapture> g_rects;
std::vector<PolygonCapture> g_polygons;
std::vector<ImageCapture> g_creates;
std::vector<ImageCapture> g_updates;

Log<GeometryEntry> g_triangle_arrays;
Log<GeometryEntry> g_primitives;
Log<GeometryEntry> g_polylines;
Log<PodEntry<NinePatchKey>> g_nine_patches;
Log<PodEntry<LineKey>> g_lines;
Log<PodEntry<CircleKey>> g_circles;
Log<PodEntry<ItemTransformKey>> g_add_set_transforms;
Log<PodEntry<ItemTransformKey>> g_set_transforms;
Log<PodEntry<ItemColorKey>> g_set_modulates;
Log<PodEntry<AddMeshKey>> g_add_meshes;
Log<PodEntry<RidTripleKey>> g_add_multimeshes;
Log<PodEntry<RidTripleKey>> g_canvas_item_creates;
Log<PodEntry<RidTripleKey>> g_canvas_item_clears;
Log<PodEntry<RidTripleKey>> g_set_materials;
Log<PodEntry<RidTripleKey>> g_mesh_creates;
Log<PodEntry<MeshSurfaceKey>> g_mesh_surfaces;
Log<PodEntry<RegionKey>> g_vertex_regions;
Log<PodEntry<RegionKey>> g_attribute_regions;
Log<PodEntry<RidTripleKey>> g_mesh_clears;
Log<PodEntry<MeshAabbKey>> g_mesh_aabbs;
Log<PodEntry<RidTripleKey>> g_shader_creates;
Log<PodEntry<RidTripleKey>> g_shader_codes;
Log<PodEntry<RidTripleKey>> g_material_params;
Log<PodEntry<RidTripleKey>> g_frees;
Log<PodEntry<RidTripleKey>> g_viewport_attaches;
Log<PodEntry<ViewportCanvasTransformKey>> g_viewport_canvas_transforms;
Log<PodEntry<RidTripleKey>> g_canvas_creates;
Log<PodEntry<RidTripleKey>> g_set_parents;
Log<PodEntry<ItemValueKey>> g_set_visibles;
Log<PodEntry<ItemValueKey>> g_set_clips;
Log<PodEntry<ItemCustomRectKey>> g_set_custom_rects;
Log<PodEntry<ItemColorKey>> g_set_self_modulates;
Log<PodEntry<ItemValueKey>> g_set_visibility_layers;
Log<PodEntry<ItemValueKey>> g_set_z_indices;
Log<PodEntry<ItemValueKey>> g_set_draw_indices;
Log<PodEntry<ItemValueKey>> g_set_z_as_relatives;
Log<PodEntry<ItemValueKey>> g_set_draw_behinds;
// calibrator 5
Log<PodEntry<TextureRectKey>> g_texture_rects{{}, 0, kMaxTextureRectEntries};
Log<PodEntry<TextureRectRegionKey>> g_texture_rect_regions{{}, 0, kMaxTextureRectEntries};
Log<PodEntry<MsdfRectKey>> g_msdf_rects{{}, 0, kMaxTextureRectEntries};
Log<PodEntry<RidTripleKey>> g_placeholder_creates;
Log<PodEntry<RidTripleKey>> g_texture_replaces;
Log<PodEntry<ItemValueKey>> g_viewport_texture_filters;
Log<PodEntry<ItemValueKey>> g_viewport_texture_repeats;
Log<PodEntry<RidTripleKey>> g_canvas_texture_creates;
Log<PodEntry<ChannelKey>> g_canvas_texture_channels;
Log<PodEntry<ItemValueKey>> g_canvas_texture_filters;
Log<PodEntry<ItemValueKey>> g_canvas_texture_repeats;
Log<PodEntry<ItemValueKey>> g_item_texture_filters;
Log<PodEntry<ItemValueKey>> g_item_texture_repeats;
Log<PodEntry<LcdRectKey>> g_lcd_rects;
// calibrator 6
Log<PodEntry<ItemValueKey>> g_clip_ignores;
// calibrator 7
Log<PodEntry<RidTripleKey>> g_mesh_create_from_surfaces_calls;
Log<PodEntry<RegionKey>> g_skin_regions, g_index_regions;
Log<PodEntry<ItemValueKey>> g_mesh_surface_removes;
Log<GeometryEntry> g_multilines;
Log<PodEntry<RidTripleKey>> g_add_particles;
Log<PodEntry<AnimationSliceKey>> g_animation_slices;
Log<PodEntry<RidTripleKey>> g_attach_skeletons;
// calibrator 8
Log<PodEntry<RidTripleKey>> g_shader_create_calls;
Log<PodEntry<ShaderDefaultTextureKey>> g_shader_default_textures;
Log<PodEntry<RidTripleKey>> g_material_create_calls;
Log<PodEntry<MaterialShaderKey>> g_material_create_from_shader_calls;
Log<PodEntry<RidTripleKey>> g_material_set_shaders;
Log<PodEntry<ItemColorKey>> g_canvas_set_modulates;
Log<PodEntry<ItemValueKey>> g_set_use_parent_materials;
Log<PodEntry<RidTripleKey>> g_set_instance_shader_parameters;
Log<PodEntry<RidTripleKey>> g_canvas_light_attaches;
// calibrator 9
Log<PodEntry<RidTripleKey>> g_viewport_remove_canvases;
Log<PodEntry<ViewportTransformKey>> g_viewport_global_canvas_transforms;
Log<PodEntry<CanvasStackingKey>> g_canvas_stackings;
Log<PodEntry<CanvasItemMirroringKey>> g_canvas_item_mirrorings;
Log<PodEntry<CanvasItemRepeatKey>> g_canvas_item_repeats;
Log<PodEntry<CanvasParentKey>> g_canvas_set_parents;

template <typename Key>
PodEntry<Key> pod(const Key &key) {
  PodEntry<Key> entry;
  std::memcpy(static_cast<void *>(&entry.key), &key, sizeof(Key));
  return entry;
}

PodEntry<RidTripleKey> rids(uint64_t a, uint64_t b = 0, uint64_t c = 0) {
  RidTripleKey key;
  zero(&key);
  key.a = a;
  key.b = b;
  key.c = c;
  return pod(key);
}

PodEntry<ItemValueKey> item_value(RID item, int64_t value) {
  ItemValueKey key;
  zero(&key);
  key.item = item.id;
  key.value = value;
  return pod(key);
}

// --- the render-stream mirror tap ---------------------------------------------
//
// With no stream (mirror disabled) every tap is one atomic load, and the hooks
// behave exactly as at gate -1. The tap never blocks or alters the forwarded
// call.

bool streaming() { return rs::mirror_enabled(); }

rs::Mirror &mirror() { return rs::mirror_instance(); }

rs2::Xform to_xform(const Transform2D &t) {
  return {t.columns[0].x, t.columns[0].y, t.columns[1].x, t.columns[1].y, t.columns[2].x,
          t.columns[2].y};
}

rs2::Color4 to_color(const Color &c) { return {c.r, c.g, c.b, c.a}; }

rs2::Rect4 to_rect(const Rect2 &r) { return {r.position.x, r.position.y, r.size.x, r.size.y}; }

// Every hooked draw op the wire has no command for: recorded as an unsupported command.
void tap_unsupported(RID item, const char *op) {
  if (streaming()) {
    mirror().add_unsupported(item.id, op, current_frame());
  }
}

// render-stream/4 (G5d; gate5-design.md Q3a): every array argument of an immediate geometry op is
// copied WHOLE here, on the calling thread, through the two-word Vector ABI (CoW-shared, so a
// later caller write cannot change what was copied). counters.json keeps its own 64-element
// truncation; the wire never does.
rs2::Point2 to_point(const Point2 &p) { return {p.x, p.y}; }

std::vector<rs2::Point2> whole_points(const Vector<Point2> *vector) {
  std::vector<rs2::Point2> out;
  if (vector == nullptr) {
    return out;
  }
  const int64_t n = vector->size();
  out.reserve(static_cast<size_t>(n > 0 ? n : 0));
  for (int64_t i = 0; i < n; ++i) {
    out.push_back(to_point(vector->ptr()[i]));
  }
  return out;
}

std::vector<rs2::Color4> whole_colors(const Vector<Color> *vector) {
  std::vector<rs2::Color4> out;
  if (vector == nullptr) {
    return out;
  }
  const int64_t n = vector->size();
  out.reserve(static_cast<size_t>(n > 0 ? n : 0));
  for (int64_t i = 0; i < n; ++i) {
    out.push_back(to_color(vector->ptr()[i]));
  }
  return out;
}

std::vector<int32_t> whole_ints(const Vector<int32_t> *vector) {
  std::vector<int32_t> out;
  if (vector != nullptr && vector->size() > 0) {
    out.assign(vector->ptr(), vector->ptr() + vector->size());
  }
  return out;
}

struct ImageBinds {
  bool resolved = false;
  bool available = false;
  GDExtensionMethodBindPtr get_width = nullptr;
  GDExtensionMethodBindPtr get_height = nullptr;
  GDExtensionMethodBindPtr get_format = nullptr;
  GDExtensionMethodBindPtr get_data_size = nullptr;
  // Gate 2 (G2a): the payload copy also needs has_mipmaps and image_ptr.
  GDExtensionMethodBindPtr has_mipmaps = nullptr;
  bool payload_available = false;
  // G8kw: Resource.duplicate(bool), the copy-on-write duplicate a texture worker reads.
  GDExtensionMethodBindPtr duplicate = nullptr;
};

ImageBinds g_image_binds;

bool same_rect_capture(const RectCapture &a, const RectCapture &b) {
  return a.item == b.item && a.antialiased == b.antialiased &&
         std::memcmp(&a.rect, &b.rect, sizeof(Rect2)) == 0 &&
         std::memcmp(&a.color, &b.color, sizeof(Color)) == 0;
}

// What the Image method binds say about a texture argument. A failed read
// leaves that value and every later one at -1, as gate -1's captures did.
struct ImageFacts {
  bool ok = false;  // width, height, format and data size all read
  int64_t width = -1;
  int64_t height = -1;
  int64_t format = -1;
  int64_t data_size = -1;
  bool mipmaps_known = false;
  bool mipmaps = false;
};

ImageFacts read_image(const Ref *image) {
  ImageFacts facts;
  if (image == nullptr || image->object == nullptr || !g_image_binds.available) {
    return facts;
  }
  int64_t value = 0;
  bool ok = true;
  ok = ok && call_int_getter(g_image_binds.get_width, image->object, &value);
  facts.width = ok ? value : -1;
  ok = ok && call_int_getter(g_image_binds.get_height, image->object, &value);
  facts.height = ok ? value : -1;
  ok = ok && call_int_getter(g_image_binds.get_format, image->object, &value);
  facts.format = ok ? value : -1;
  ok = ok && call_int_getter(g_image_binds.get_data_size, image->object, &value);
  facts.data_size = ok ? value : -1;
  facts.ok = ok;
  if (ok && g_image_binds.has_mipmaps != nullptr) {
    // A bool return: ptrcall writes one byte into the zeroed slot.
    value = 0;
    if (call_int_getter(g_image_binds.has_mipmaps, image->object, &value)) {
      facts.mipmaps_known = true;
      facts.mipmaps = (value & 0xff) != 0;
    }
  }
  return facts;
}

ImageCapture describe_image(const ImageFacts &facts, uint64_t rid, int64_t layer) {
  return {rid,         current_frame(), layer,        facts.ok,
          facts.width, facts.height,    facts.format, facts.data_size};
}

// --- texture payloads (gate2-design.md D3, Q3 "Copy") ------------------------
//
// With a stream enabled, texture_2d_create and texture_2d_update copy the Image
// bytes into a canonical GRT1 payload and hash it, on the calling thread
// (loader threads included), before the call is forwarded. No engine reference
// is kept. G2a logs the copy (evidence/resources.jsonl) and keeps no payload;
// G2b2's texture mirror will.

struct ResourcePolicy {
  rs::FormatPolicy formats;
  uint64_t max_payload_bytes = rs::kDefaultMaxPayloadBytes;
};

ResourcePolicy g_resource_policy;
std::thread::id g_main_thread;
// G8kw (rs_texture_worker.h): GRC_TEXTURE_WORKERS's worker count (0: sync, the default) and
// GRC_TEXTURE_WORKER_MIN_BYTES, set at arm and cleared at stream finish by the main thread while
// loader threads may be inside a texture hook, hence atomics.
std::atomic<int> g_texture_workers{0};
std::atomic<uint64_t> g_texture_worker_min_bytes{0};

uint64_t now_ns() {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                   std::chrono::steady_clock::now().time_since_epoch())
                                   .count());
}

rs::TapContext tap_context() {
  rs::TapContext ctx;
  ctx.frame = current_frame();
  ctx.t_ns = now_ns();
  ctx.main_thread = std::this_thread::get_id() == g_main_thread;
  return ctx;
}

rs::ResourceLog &resources() { return rs::resource_log(); }

// Q3 "Copy", steps 2-3: the GRT1 payload of `size` data bytes and its SHA-256, timed separately.
void build_payload(const std::string &meta, const uint8_t *data, int64_t size,
                   rs::PayloadCopy *copy, rs::PayloadPtr *bytes) {
  const uint64_t t0 = now_ns();
  auto payload = std::make_shared<rs::PayloadBytes>();
  rs::payload_header(meta, static_cast<uint64_t>(size), payload.get());
  payload->insert(payload->end(), data, data + size);
  const uint64_t t1 = now_ns();
  copy->hash = sha256_hex(payload->data(), payload->size());
  const uint64_t t2 = now_ns();
  copy->status = "ok";
  copy->payload_bytes = static_cast<int64_t>(payload->size());
  copy->copy_ns = static_cast<int64_t>(t1 - t0);
  copy->hash_ns = static_cast<int64_t>(t2 - t1);
  *bytes = std::move(payload);
}

// G8t (gate8-design.md D8, Q3): the payload of a host-decoded image. `copy` holds the source's
// facts; on success it becomes the decoded payload's (format, size), with `source_format` the
// format the host decoded from and `decode_ns` the seam's duplicate + decompress time. A decoded
// payload the policy still refuses (its format outside GRC_RESOURCE_FORMATS, or over
// GRC_RESOURCE_MAX_PAYLOAD_BYTES) keeps the source's facts, as the refusal it would otherwise be.
rs::PayloadCopy copy_decoded(rs::PayloadCopy copy, const rs::DecodeResult &decoded,
                             rs::PayloadPtr *bytes) {
  copy.decode_ns = decoded.decode_ns;
  if (decoded.format < 0 || decoded.format >= rs::kImageFormatCount ||
      !g_resource_policy.formats.permitted[decoded.format]) {
    copy.reason = "unsupported-format";
    return copy;
  }
  const int64_t expected = rs::expected_data_bytes(decoded.format, decoded.width, decoded.height,
                                                   decoded.mipmaps);
  if (expected < 0 || expected != decoded.data_size || decoded.data == nullptr) {
    copy.reason = "payload-unavailable";
    return copy;
  }
  const std::string meta =
      rs::payload_meta(rs::image_format_name(decoded.format), decoded.width, decoded.height,
                       decoded.mipmaps, decoded.data_size);
  if (rs::payload_size(meta, static_cast<uint64_t>(decoded.data_size)) >
      g_resource_policy.max_payload_bytes) {
    copy.reason = "payload-too-large";
    return copy;
  }
  build_payload(meta, decoded.data, decoded.data_size, &copy, bytes);
  copy.source_format = copy.format;
  copy.format = decoded.format;
  copy.width = decoded.width;
  copy.height = decoded.height;
  copy.mipmaps = decoded.mipmaps;
  copy.data_bytes = decoded.data_size;
  return copy;
}

// G8kc (texture-delivery-design.md D7): the hooked image as a GRT1 payload in its own format. Its
// hash is the cache's source key, and for a block source it is also the `block` variant.
struct SourcePayload {
  bool built = false;
  rs::PayloadCopy copy;  // hash, payload_bytes
  rs::PayloadPtr bytes;
  std::string format_name;
};

SourcePayload build_source_payload(int64_t source_format, int64_t width, int64_t height,
                                   bool mipmaps, int64_t source_bytes, const uint8_t *data) {
  SourcePayload out;
  const char *name = rs::image_format_name(source_format);
  if (name == nullptr || data == nullptr || source_bytes < 0) {
    return out;
  }
  out.format_name = name;
  const std::string meta = rs::payload_meta(name, width, height, mipmaps, source_bytes);
  build_payload(meta, data, source_bytes, &out.copy, &out.bytes);
  out.built = true;
  return out;
}

// G8kp (texture-delivery-design.md D1 `passthrough`, rs_texture_delivery.h): beside an ok host
// decode, the hooked block bytes as a GRT1 payload in their own block format, hashed here (the
// calling thread, or the worker that made the decode). `data` is the source image's own buffer,
// read only. Nothing happens unless a /9 stream runs a mode offering `block`, so every other
// stream's bytes are unchanged; a source whose size is not Godot's for its shape gets no variant
// (counted, never a wrong payload). G8kc: `prebuilt` is the same payload when the cache already
// built it for the source key.
void attach_block_variant(rs::PayloadCopy *copy, int64_t source_format, int64_t width,
                          int64_t height, bool mipmaps, int64_t source_bytes,
                          const uint8_t *data, const SourcePayload *prebuilt = nullptr) {
  if (!rs::texture_delivery_block_enabled() || copy->status != "ok" || copy->source_format < 0) {
    return;
  }
  const char *name = rs::image_format_name(source_format);
  const int64_t expected =
      name != nullptr ? rs::block_data_bytes(name, width, height, mipmaps) : -1;
  if (expected < 0 || expected != source_bytes || data == nullptr) {
    rs::texture_delivery_note_block(false, 0);
    return;
  }
  rs::PayloadCopy block;
  rs::PayloadPtr bytes;
  if (prebuilt != nullptr && prebuilt->built) {
    block = prebuilt->copy;
    bytes = prebuilt->bytes;
  } else {
    const std::string meta = rs::payload_meta(name, width, height, mipmaps, source_bytes);
    build_payload(meta, data, source_bytes, &block, &bytes);
  }
  copy->block_hash = block.hash;
  copy->block_format = name;
  copy->block_payload_bytes = block.payload_bytes;
  copy->block_bytes = std::move(bytes);
  rs::texture_delivery_note_block(true, static_cast<uint64_t>(block.payload_bytes));
}

// G8kc (texture-delivery-design.md D7, D8): the host decode through the persisted cache. The
// source key is the hash of the hooked image's own GRT1 payload; a verified file for (key,
// decoded, params) stands in for the engine's decompress, and a derived payload is stored. The
// cache is bypassed (outcome "uncached") while the perturb-decode sabotage is configured, so a
// warm cache can never hide it. With the cache off this is exactly texture_decode + copy_decoded.
constexpr const char *kDecodeParamsId = "engine-decompress/4.5.1";

rs::PayloadCopy derive_decoded(const rs::PayloadCopy &copy, rs::DecodeRequest request,
                               const uint8_t *src_data, rs::PayloadPtr *bytes, bool *handled,
                               SourcePayload *source) {
  *handled = false;
  rs::TextureCache &cache = rs::texture_cache();
  const bool cached = cache.enabled();
  std::string outcome = cached ? "uncached" : "";
  rs::CacheKey key;
  bool keyed = false;
  if (cached) {
    *source = build_source_payload(copy.format, copy.width, copy.height, copy.mipmaps,
                                   copy.data_bytes, src_data);
    if (source->built) {
      key.source = source->copy.hash;
      key.encoding = "decoded";
      key.params = kDecodeParamsId;
      keyed = !rs::texture_decode_perturb_active();
    }
  }
  if (keyed) {
    std::vector<uint8_t> data;
    std::string hash;
    const rs::CacheResult result = cache.get(key, &data, &hash);
    outcome = result == rs::CacheResult::Hit ? "hit"
              : result == rs::CacheResult::Corrupt ? "corrupt" : "miss";
    if (result == rs::CacheResult::Hit) {
      // The same facts copy_decoded derives from a decode: the D8 table's format, the source's shape.
      const int64_t target = rs::decode_target_format(copy.format);
      const int64_t expected =
          target >= 0 ? rs::expected_data_bytes(target, copy.width, copy.height, copy.mipmaps) : -1;
      const std::string meta =
          expected >= 0 ? rs::payload_meta(rs::image_format_name(target), copy.width, copy.height,
                                           copy.mipmaps, expected)
                        : std::string();
      if (expected >= 0 && target < rs::kImageFormatCount &&
          g_resource_policy.formats.permitted[target] &&
          rs::payload_size(meta, static_cast<uint64_t>(expected)) == data.size()) {
        rs::PayloadCopy out = copy;
        out.status = "ok";
        out.decode_ns = 0;
        out.copy_ns = 0;
        out.hash_ns = 0;
        out.hash = hash;
        out.payload_bytes = static_cast<int64_t>(data.size());
        out.source_format = copy.format;
        out.format = target;
        out.data_bytes = expected;
        out.source_key = key.source;
        out.cache_outcome = "hit";
        *bytes = std::make_shared<rs::PayloadBytes>(std::move(data));
        *handled = true;
        return out;
      }
      outcome = "corrupt";  // a file that verifies but is not this decode's payload: derive again
    }
  }
  const rs::DecodeResult decoded = rs::texture_decode(request);
  if (!decoded.handled) {
    rs::PayloadCopy out = copy;
    out.decode_ns = decoded.decode_ns;
    return out;
  }
  *handled = true;
  rs::PayloadCopy out = copy_decoded(copy, decoded, bytes);
  out.source_key = source->built ? source->copy.hash : std::string();
  out.cache_outcome = outcome;
  if (keyed && out.status == "ok" && *bytes != nullptr && !decoded.perturbed) {
    cache.put(key, out.hash, (*bytes)->data(), (*bytes)->size(), "grt");
  }
  return out;
}

// G8kc: an ok payload that needs no derivation is its own source: its hash is the D7 key.
void note_source_payload(rs::PayloadCopy *copy) {
  if (copy->status == "ok" && rs::texture_cache().enabled()) {
    copy->source_key = copy->hash;
    copy->cache_outcome = "source";
  }
}

// --- G8kw: the texture worker path (texture-delivery-design.md D11, rs_texture_worker.h) -------
//
// The hook keeps every fact-based decision of copy_payload (status, reason, shape, payload size)
// and hands only the content -- copy, decode, hash -- to a worker, on a copy-on-write duplicate of
// the Image (Image::_duplicate shares the engine's bytes; the engine copies on its next write).

// The duplicate's Ref slot; dropping it releases the duplicate on whichever thread does so.
struct ImageDuplicate {
  void *slot = nullptr;
  void *object = nullptr;
  ~ImageDuplicate() {
    if (slot != nullptr && g_iface.ref_set_object != nullptr) {
      g_iface.ref_set_object(&slot, nullptr);
    }
  }
};

std::shared_ptr<ImageDuplicate> duplicate_image(void *image) {
  if (image == nullptr || g_image_binds.duplicate == nullptr ||
      g_iface.object_method_bind_ptrcall == nullptr || g_iface.ref_get_object == nullptr ||
      g_iface.ref_set_object == nullptr) {
    return nullptr;
  }
  auto dup = std::make_shared<ImageDuplicate>();
  const uint8_t deep = 0;  // GDExtensionBool: duplicate(false)
  const void *args[] = {&deep};
  g_iface.object_method_bind_ptrcall(g_image_binds.duplicate, image, args, &dup->slot);
  dup->object = g_iface.ref_get_object(&dup->slot);
  return dup->object != nullptr ? dup : nullptr;
}

// Whether this copy goes to a worker: N workers, a running pool, a payload of at least min_bytes.
bool worker_copy(int64_t data_bytes) {
  return g_texture_workers.load(std::memory_order_acquire) > 0 && data_bytes >= 0 &&
         static_cast<uint64_t>(data_bytes) >=
             g_texture_worker_min_bytes.load(std::memory_order_acquire) &&
         rs::texture_worker_pool().running();
}

// The worker side: exactly copy_payload's copy (or copy_decoded's decode) on the duplicate.
void run_texture_job(const rs::TextureJobPtr &job, std::shared_ptr<ImageDuplicate> dup,
                     rs::PayloadCopy base, bool decode, rs::DecodeRequest request,
                     const std::string &meta) {
  rs::PayloadPtr bytes;
  rs::PayloadCopy actual = base;
  if (decode) {
    request.image = dup->object;
    bool handled = false;
    SourcePayload source;
    const uint8_t *src_data = g_iface.image_ptr(dup->object);  // const: never a copy-on-write
    actual = derive_decoded(base, request, src_data, &bytes, &handled, &source);
    if (handled) {
      attach_block_variant(&actual, base.format, base.width, base.height, base.mipmaps,
                           base.data_bytes, src_data, &source);
    } else {
      actual.reason = "unsupported-format";
    }
  } else {
    const uint8_t *data = g_iface.image_ptr(dup->object);  // const: never a copy-on-write
    if (data == nullptr) {
      actual.reason = "payload-unavailable";
    } else {
      build_payload(meta, data, base.data_bytes, &actual, &bytes);
      note_source_payload(&actual);
    }
  }
  dup.reset();  // the duplicate dies here, before the job is visible as done
  job->finish(actual, std::move(bytes));
}

// Hands `predicted`'s content to a worker. False (nothing submitted) when the duplicate or the
// pool is unavailable: the caller then copies synchronously.
bool submit_texture_job(rs::PayloadCopy *predicted, const rs::PayloadCopy &base, const Ref *image,
                        bool decode, const rs::DecodeRequest &request, const std::string &meta,
                        rs::TextureJobPtr *job_out) {
  const uint64_t t0 = now_ns();
  std::shared_ptr<ImageDuplicate> dup = duplicate_image(image->object);
  const uint64_t t1 = now_ns();
  if (dup == nullptr) {
    return false;
  }
  auto job = std::make_shared<rs::TextureJob>(*predicted);
  if (!rs::texture_worker_pool().submit([job, dup, base, decode, request, meta]() mutable {
        run_texture_job(job, std::move(dup), base, decode, request, meta);
      })) {
    return false;
  }
  predicted->worker = true;
  predicted->dup_ns = static_cast<int64_t>(t1 - t0);
  *job_out = std::move(job);
  return true;
}

// Q3 "Copy", steps 1-3. Nothing is copied for an unreadable Image, a format
// outside GRC_RESOURCE_FORMATS or a payload over GRC_RESOURCE_MAX_PAYLOAD_BYTES.
// The GRT1 bytes go to `bytes` (G2b2: the texture mirror keeps them); null
// unless the copy is "ok". G8kw: under GRC_TEXTURE_WORKERS=<N> an "ok" copy may instead be a
// prediction whose content `*job` delivers (`bytes` then stays null).
rs::PayloadCopy copy_payload(const ImageFacts &facts, const Ref *image, rs::PayloadPtr *bytes,
                             rs::TextureJobPtr *job) {
  bytes->reset();
  job->reset();
  rs::PayloadCopy copy;
  copy.format = facts.format;
  copy.width = facts.width;
  copy.height = facts.height;
  copy.mipmaps_known = facts.mipmaps_known;
  copy.mipmaps = facts.mipmaps;
  copy.data_bytes = facts.data_size;
  if (!facts.ok || !facts.mipmaps_known || !g_image_binds.payload_available) {
    copy.reason = "payload-unavailable";
    return copy;
  }
  if (facts.format < 0 || facts.format >= rs::kImageFormatCount ||
      !g_resource_policy.formats.permitted[facts.format]) {
    if (rs::texture_decode_enabled() && facts.format >= 0 && facts.format < rs::kImageFormatCount) {
      // G8t (gate8-design.md D8): under GRC_TEXTURE_DECODE=engine the host-decode seam
      // (rs_texture_decode.cpp) turns a block-compressed image into an RGBA8/R8/RG8 payload with
      // the engine's own Image::decompress, on a duplicate; it declines everything else.
      const int64_t target = rs::decode_target_format(facts.format);
      if (target >= 0 && (target >= rs::kImageFormatCount ||
                          !g_resource_policy.formats.permitted[target])) {
        // G8f: a decode whose payload the policy would refuse is not run. BC6H and ASTC HDR
        // decode to half floats (RGBH, RGBAH), which only a GRC_RESOURCE_FORMATS naming them
        // admits; without that the texture keeps G8t's typed refusal and costs nothing.
        copy.reason = "unsupported-format";
        return copy;
      }
      rs::DecodeRequest request;
      request.format = facts.format;
      request.width = static_cast<int32_t>(facts.width);
      request.height = static_cast<int32_t>(facts.height);
      request.mipmaps = facts.mipmaps;
      request.image = image->object;
      request.frame = current_frame();
      if (target >= 0 && g_texture_workers.load(std::memory_order_acquire) > 0) {
        // G8kw: the decode's outcome predicted from the D8 table, its content left to a worker. A
        // decoded payload the policy would refuse stays synchronous (the refusal keeps the
        // source's facts and a measured decode_ns, as before).
        const int64_t expected =
            rs::expected_data_bytes(target, facts.width, facts.height, facts.mipmaps);
        const std::string meta =
            expected >= 0 ? rs::payload_meta(rs::image_format_name(target), facts.width,
                                             facts.height, facts.mipmaps, expected)
                          : std::string();
        if (expected >= 0 && target < rs::kImageFormatCount &&
            g_resource_policy.formats.permitted[target] &&
            rs::payload_size(meta, static_cast<uint64_t>(expected)) <=
                g_resource_policy.max_payload_bytes &&
            worker_copy(expected)) {
          rs::PayloadCopy predicted = copy;
          predicted.source_format = copy.format;
          predicted.format = target;
          predicted.data_bytes = expected;
          predicted.status = "ok";
          predicted.payload_bytes =
              static_cast<int64_t>(rs::payload_size(meta, static_cast<uint64_t>(expected)));
          if (submit_texture_job(&predicted, copy, image, true, request, meta, job)) {
            return predicted;
          }
        }
      }
      bool handled = false;
      SourcePayload source;
      const uint8_t *src_data = g_iface.image_ptr(image->object);
      rs::PayloadCopy out = derive_decoded(copy, request, src_data, bytes, &handled, &source);
      if (handled) {
        attach_block_variant(&out, facts.format, facts.width, facts.height, facts.mipmaps,
                             facts.data_size, src_data, &source);
        return out;
      }
      copy.decode_ns = out.decode_ns;  // the cost of a decode that was tried and refused
    }
    copy.reason = "unsupported-format";
    return copy;
  }
  const int64_t expected =
      rs::expected_data_bytes(facts.format, facts.width, facts.height, facts.mipmaps);
  if (expected < 0 || expected != facts.data_size) {
    // The Image does not hold the bytes its shape implies: nothing safe to copy.
    copy.reason = "payload-unavailable";
    return copy;
  }
  const std::string meta = rs::payload_meta(rs::image_format_name(facts.format), facts.width,
                                            facts.height, facts.mipmaps, facts.data_size);
  if (rs::payload_size(meta, static_cast<uint64_t>(facts.data_size)) >
      g_resource_policy.max_payload_bytes) {
    copy.reason = "payload-too-large";
    return copy;
  }
  if (worker_copy(facts.data_size)) {
    // G8kw: the shape and size are final here; only the bytes and their hash are the worker's.
    rs::PayloadCopy predicted = copy;
    predicted.status = "ok";
    predicted.payload_bytes =
        static_cast<int64_t>(rs::payload_size(meta, static_cast<uint64_t>(facts.data_size)));
    if (submit_texture_job(&predicted, copy, image, false, rs::DecodeRequest(), meta, job)) {
      return predicted;
    }
  }
  const uint8_t *data = g_iface.image_ptr(image->object);
  if (data == nullptr) {
    copy.reason = "payload-unavailable";
    return copy;
  }
  build_payload(meta, data, facts.data_size, &copy, bytes);
  note_source_payload(&copy);
  return copy;
}

// Whether the omit-op sabotage drops this texture call. The hook then leaves it
// out of the mirror and of the hook log's registry alike (the log still writes
// the line, marked omitted), so the two stay in agreement and the sabotage
// shows as pixels, not as texture-log-divergence (gate2-design.md G2b2).
bool omitted(const char *op) { return streaming() && mirror().omits(op, current_frame()); }

// The mirror and the hook log assign texture ids independently, each under its own lock, from
// the same sequence of identity calls (gate2-design.md D2). Loader threads create textures too, so
// every texture identity tap holds this lock across both calls: the two see the calls in one
// order and assign the same ids (`texture-versions-current` compares them).
std::mutex g_texture_order;

// --- gate 5 (G5a): mesh payload copy at the hook (gate5-design.md D6, D7, Q3a) ---------------
//
// mesh_add_surface and mesh_create_from_surfaces copy every buffer of the SurfaceData, exactly as
// texture_2d_create copies an Image's bytes. Unlike a texture, a region update only ever carries
// the changed bytes (`p_data` at `offset`): the dummy renderer discards region updates entirely
// (rs-gate5-geometry-engine-facts), so the hook's own retained copy of each surface's whole
// buffers -- kept here, one entry per mesh RID the hook has seen created or added to, in creation
// order -- is the only place a region update's result exists on a headless host. A refused
// surface (D7) keeps its descriptive fields but no bytes: nothing will ever re-hash it (a region
// update on it is "version + 1 only", gate5-design.md Q3b).
struct MeshSurfaceBuffer {
  bool ok = false;
  int32_t primitive = -1;
  uint64_t format = 0;
  uint32_t vertex_count = 0;
  uint32_t index_count = 0;
  // The surface's own AABB and uv_scale, fixed at creation (D8: region updates never move the
  // AABB) and needed again to re-encode the GRM1 geometry block after a region update.
  AABB aabb{};
  Vector4 uv_scale{};
  std::vector<uint8_t> vertex_data, attribute_data, skin_data, index_data;
};

std::map<uint64_t, std::vector<MeshSurfaceBuffer>> g_mesh_buffers;  // guarded by g_mutex

// Classifies and, when ok, copies and hashes one SurfaceData-shaped pointer. `copy_ns`/`hash_ns`
// time the GRM1 encode and the SHA-256 separately, as copy_payload does for textures. Nothing is
// copied or hashed for a refused surface (D7) or one over GRC_RESOURCE_MAX_PAYLOAD_BYTES. Since
// G5e the encoded payload is handed back in `payload` (null unless ok): the mirror's mesh table
// keeps it, shared, never copied again (gate5-design.md D5, D6).
// The fields copy_mesh_surface reads, whether from the engine's SurfaceData (a hook argument) or
// from a mesh_get_surface read-back (G8r adoption): the same classification, encode and hash.
struct SurfaceView {
  int32_t primitive = 0;
  uint64_t format = 0;
  uint32_t vertex_count = 0;
  uint32_t index_count = 0;
  AABB aabb{};
  Vector4 uv_scale{};
  const uint8_t *vertex = nullptr;
  size_t vertex_bytes = 0;
  const uint8_t *attribute = nullptr;
  size_t attribute_bytes = 0;
  const uint8_t *skin = nullptr;
  size_t skin_bytes = 0;
  const uint8_t *index = nullptr;
  size_t index_bytes = 0;
  int64_t blend_shape_bytes = 0;
};

SurfaceView surface_view(const SurfaceDataPrefix &sd) {
  SurfaceView v;
  v.primitive = sd.primitive;
  v.format = sd.format;
  v.vertex_count = sd.vertex_count;
  v.index_count = sd.index_count;
  v.aabb = sd.aabb;
  v.uv_scale = sd.uv_scale;
  v.vertex = sd.vertex_data.ptr();
  v.vertex_bytes = static_cast<size_t>(sd.vertex_data.size());
  v.attribute = sd.attribute_data.ptr();
  v.attribute_bytes = static_cast<size_t>(sd.attribute_data.size());
  v.skin = sd.skin_data.ptr();
  v.skin_bytes = static_cast<size_t>(sd.skin_data.size());
  v.index = sd.index_data.ptr();
  v.index_bytes = static_cast<size_t>(sd.index_data.size());
  v.blend_shape_bytes = sd.blend_shape_data.size();
  return v;
}

void assign_bytes(std::vector<uint8_t> *out, const uint8_t *data, size_t size) {
  if (data == nullptr || size == 0) {
    out->clear();
    return;
  }
  out->assign(data, data + size);
}

rs::MeshSurfaceCopy copy_mesh_surface(const SurfaceView &sd, MeshSurfaceBuffer *buffer,
                                      rs::PayloadPtr *payload_out) {
  rs::MeshSurfaceCopy copy;
  copy.primitive = sd.primitive;
  copy.format = sd.format;
  copy.vertex_count = sd.vertex_count;
  copy.index_count = sd.index_count;

  rs::SurfaceFacts facts;
  facts.primitive = sd.primitive;
  facts.format = sd.format;
  facts.vertex_data_bytes = static_cast<int64_t>(sd.vertex_bytes);
  facts.attribute_data_bytes = static_cast<int64_t>(sd.attribute_bytes);
  facts.skin_data_bytes = static_cast<int64_t>(sd.skin_bytes);
  facts.index_data_bytes = static_cast<int64_t>(sd.index_bytes);
  facts.vertex_count = sd.vertex_count;
  facts.index_count = sd.index_count;
  facts.blend_shape_data_bytes = sd.blend_shape_bytes;
  const rs::SurfaceClassification classification = rs::classify_surface(facts);

  buffer->ok = false;
  buffer->primitive = sd.primitive;
  buffer->format = sd.format;
  buffer->vertex_count = sd.vertex_count;
  buffer->index_count = sd.index_count;
  buffer->aabb = sd.aabb;
  buffer->uv_scale = sd.uv_scale;
  buffer->vertex_data.clear();
  buffer->attribute_data.clear();
  buffer->skin_data.clear();
  buffer->index_data.clear();
  payload_out->reset();
  if (!classification.ok) {
    copy.status = "unsupported";
    copy.reason = classification.reason;
    return copy;
  }

  const std::string meta = rs::payload_meta(
      sd.primitive, sd.format, sd.vertex_count, sd.index_count,
      static_cast<int64_t>(sd.vertex_bytes), static_cast<int64_t>(sd.attribute_bytes),
      static_cast<int64_t>(sd.skin_bytes), static_cast<int64_t>(sd.index_bytes));
  const uint64_t data_bytes = static_cast<uint64_t>(sd.vertex_bytes) +
                              static_cast<uint64_t>(sd.attribute_bytes) +
                              static_cast<uint64_t>(sd.skin_bytes) +
                              static_cast<uint64_t>(sd.index_bytes);
  if (rs::mesh_payload_size(meta, data_bytes) > g_resource_policy.max_payload_bytes) {
    copy.status = "unsupported";
    copy.reason = "payload-too-large";
    return copy;
  }

  const uint64_t t0 = now_ns();
  assign_bytes(&buffer->vertex_data, sd.vertex, sd.vertex_bytes);
  assign_bytes(&buffer->attribute_data, sd.attribute, sd.attribute_bytes);
  assign_bytes(&buffer->skin_data, sd.skin, sd.skin_bytes);
  assign_bytes(&buffer->index_data, sd.index, sd.index_bytes);
  auto payload = std::make_shared<rs::PayloadBytes>(rs::encode_payload(
      sd.primitive, sd.format, sd.vertex_count, sd.index_count, sd.aabb, sd.uv_scale,
      buffer->vertex_data.data(), buffer->vertex_data.size(), buffer->attribute_data.data(),
      buffer->attribute_data.size(), buffer->skin_data.data(), buffer->skin_data.size(),
      buffer->index_data.data(), buffer->index_data.size()));
  const uint64_t t1 = now_ns();
  copy.hash = sha256_hex(payload->data(), payload->size());
  const uint64_t t2 = now_ns();
  copy.status = "ok";
  copy.copy_ns = static_cast<int64_t>(t1 - t0);
  copy.hash_ns = static_cast<int64_t>(t2 - t1);
  buffer->ok = true;
  *payload_out = std::move(payload);
  return copy;
}

rs::MeshSurfaceCopy copy_mesh_surface(const SurfaceDataPrefix &sd, MeshSurfaceBuffer *buffer,
                                      rs::PayloadPtr *payload_out) {
  return copy_mesh_surface(surface_view(sd), buffer, payload_out);
}

// Re-encodes and re-hashes a surface already in `buffer` (whole payload, D6): used after a region
// update is applied in place. `buffer.ok` must already be true (a refused surface is never
// re-hashed; its region updates are "version + 1 only"). The new payload goes to `payload_out`
// (G5e: the mirror's new surface version).
rs::MeshSurfaceCopy rehash_mesh_surface(const MeshSurfaceBuffer &buffer,
                                        rs::PayloadPtr *payload_out) {
  rs::MeshSurfaceCopy copy;
  copy.primitive = buffer.primitive;
  copy.format = buffer.format;
  copy.vertex_count = buffer.vertex_count;
  copy.index_count = buffer.index_count;
  const uint64_t t0 = now_ns();
  auto payload = std::make_shared<rs::PayloadBytes>(rs::encode_payload(
      buffer.primitive, buffer.format, buffer.vertex_count, buffer.index_count, buffer.aabb,
      buffer.uv_scale, buffer.vertex_data.data(), buffer.vertex_data.size(),
      buffer.attribute_data.data(), buffer.attribute_data.size(), buffer.skin_data.data(),
      buffer.skin_data.size(), buffer.index_data.data(), buffer.index_data.size()));
  const uint64_t t1 = now_ns();
  copy.hash = sha256_hex(payload->data(), payload->size());
  const uint64_t t2 = now_ns();
  copy.status = "ok";
  copy.copy_ns = static_cast<int64_t>(t1 - t0);
  copy.hash_ns = static_cast<int64_t>(t2 - t1);
  *payload_out = std::move(payload);
  return copy;
}

// --- gate 5.5 (G55a): shader code and material parameter decode at the hook (gate5_5-design.md
// D7, D8, D11, Q2 "Decoding", Q3a "Copy and classify at the hook") -----------------------------
//
// shader_create_from_code and shader_set_code copy the code as UTF-8, build the render-stream-
// shader/1 (GRP1) payload and hash it, exactly as copy_payload does for a texture's Image bytes
// and copy_mesh_surface does for a mesh surface. A D11 reason (TIME, screen texture, SDF, global
// uniform, a shader_type other than canvas_item) makes the shader `unsupported`; the D7
// CanvasItemMaterial recognizer runs regardless (a recognized engine-generated shader is never
// refused by D11, Q1e). `copy_ns` covers the UTF-8 decode and the payload encode, `scan_ns` the
// token scan and the template comparison, `hash_ns` the SHA-256 alone.
rs::ShaderCopy copy_shader_code_text(const std::string &code, uint64_t t0,
                                     rs::PayloadPtr *payload_out = nullptr) {
  rs::ShaderCopy copy;
  copy.code_bytes = static_cast<int64_t>(code.size());
  const uint64_t t_decode = now_ns();
  const rs::ShaderScan scan = rs::scan_shader_code(code);
  const rs::CanvasItemMaterialBuiltin builtin = rs::recognize_canvas_item_material(code);
  const uint64_t t_scan = now_ns();
  copy.mode = scan.mode;
  copy.uses = scan.uses;
  copy.builtin = builtin.recognized;
  copy.builtin_blend_mode = builtin.blend_mode;
  copy.builtin_light_mode = builtin.light_mode;
  copy.builtin_particles_animation = builtin.particles_animation;
  copy.scan_ns = static_cast<int64_t>(t_scan - t_decode);
  if (!scan.reason.empty()) {
    copy.status = "unsupported";
    copy.reason = scan.reason;
  } else {
    copy.status = "ok";
  }
  const std::string meta = rs::payload_meta(static_cast<uint64_t>(code.size()));
  if (rs::shader_payload_size(meta, static_cast<uint64_t>(code.size())) >
      g_resource_policy.max_payload_bytes) {
    copy.status = "unsupported";
    copy.reason = "payload-too-large";
    copy.copy_ns = static_cast<int64_t>(t_decode - t0);
    return copy;
  }
  auto payload = std::make_shared<rs::PayloadBytes>(rs::encode_payload(code));
  const uint64_t t_encode = now_ns();
  copy.hash = sha256_hex(payload->data(), payload->size());
  const uint64_t t_hash = now_ns();
  copy.payload_bytes = static_cast<int64_t>(payload->size());
  copy.copy_ns = static_cast<int64_t>((t_decode - t0) + (t_encode - t_scan));
  copy.hash_ns = static_cast<int64_t>(t_hash - t_encode);
  if (payload_out != nullptr) {
    *payload_out = std::move(payload);  // G55d: the mirror's shader table shares these bytes
  }
  return copy;
}

rs::ShaderCopy copy_shader_code(const void *code_ptr, rs::PayloadPtr *payload_out = nullptr) {
  const uint64_t t0 = now_ns();
  return copy_shader_code_text(rs::decode_string(code_ptr), t0, payload_out);
}

// G8m (gate8-design.md D4, D11): the capture's own temporary objects. While a thread is inside
// hooks_internal_begin/end, shader_create_from_code hands the code it receives to the caller
// (rs_adopt.cpp's temporary Shader) instead of the mirror and the hook log, and every other
// shader and free call passes straight to the engine: none of them is the game's.
thread_local bool t_internal = false;
thread_local std::string *t_internal_code = nullptr;
thread_local uint64_t *t_internal_rid = nullptr;

// A material or instance parameter's Variant value (D8), classified applied/rejected/unknown
// (D6) for the hook log; the decoded name and value never reach counters.json (Q2).
rs::MaterialParamCopy decode_material_param(const void *value_ptr,
                                            rs::DecodedParam *decoded_out = nullptr) {
  const uint64_t t0 = now_ns();
  rs::DecodedParam decoded = rs::decode_variant(value_ptr);
  const uint64_t t1 = now_ns();
  rs::MaterialParamCopy copy;
  copy.type = decoded.type;
  copy.n = decoded.n;
  copy.decode_ns = static_cast<int64_t>(t1 - t0);
  if (decoded.status == "ok") {
    copy.outcome = "applied";
  } else if (decoded.type == "object") {
    copy.outcome = "rejected";
  } else {
    copy.outcome = "unknown";
  }
  if (decoded_out != nullptr) {
    *decoded_out = std::move(decoded);  // G55d: the mirror keeps the value itself
  }
  return copy;
}

// --- gate -1 hooks -----------------------------------------------------------

void hook_add_rect(void *self, RID item, const Rect2 *rect, const Color *color, bool antialiased) {
  bump(kAddRect);
  if (rect != nullptr && color != nullptr) {
    RectCapture capture = {item.id, *rect, *color, antialiased};
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_rects.size() < kMaxRects) {
      bool seen = false;
      for (const RectCapture &existing : g_rects) {
        if (same_rect_capture(existing, capture)) {
          seen = true;
          break;
        }
      }
      if (!seen) {
        g_rects.push_back(capture);
      }
    }
  }
  if (streaming() && rect != nullptr && color != nullptr) {
    mirror().add_rect(item.id, to_rect(*rect), to_color(*color), antialiased, current_frame());
  }
  original<FnAddRect>(kAddRect)(self, item, rect, color, antialiased);
}

void hook_add_texture_rect(void *self, RID item, const Rect2 *rect, RID texture, bool tile,
                           const Color *modulate, bool transpose) {
  bump(kAddTextureRect);
  rs::adopt_texture_ref(texture.id);  // G8r: a pre-arm texture is adopted at first reference
  if (streaming() && rect != nullptr && modulate != nullptr) {
    // A mirror tap since G2b2 (gate2-design.md Q3): the raw arguments, flips included.
    mirror().add_texture_rect(item.id, to_rect(*rect), texture.id, tile, to_color(*modulate),
                              transpose, current_frame());
  }
  if (rect != nullptr && modulate != nullptr) {
    // Full capture since calibrator 5 (gate2-design.md Q2): the raw arguments,
    // negative sizes (flips) included.
    TextureRectKey key;
    zero(&key);
    key.item = item.id;
    key.rect = *rect;
    key.texture = texture.id;
    key.modulate = *modulate;
    key.tile = tile;
    key.transpose = transpose;
    log_entry(&g_texture_rects, pod(key));
  }
  original<FnAddTextureRect>(kAddTextureRect)(self, item, rect, texture, tile, modulate,
                                              transpose);
}

void hook_add_texture_rect_region(void *self, RID item, const Rect2 *rect, RID texture,
                                  const Rect2 *source, const Color *modulate, bool transpose,
                                  bool clip_uv) {
  bump(kAddTextureRectRegion);
  rs::adopt_texture_ref(texture.id);  // G8r: a pre-arm texture is adopted at first reference
  if (streaming() && rect != nullptr && source != nullptr && modulate != nullptr) {
    mirror().add_texture_rect_region(item.id, to_rect(*rect), texture.id, to_rect(*source),
                                     to_color(*modulate), transpose, clip_uv, current_frame());
  }
  if (rect != nullptr && source != nullptr && modulate != nullptr) {
    TextureRectRegionKey key;
    zero(&key);
    key.item = item.id;
    key.rect = *rect;
    key.texture = texture.id;
    key.source = *source;
    key.modulate = *modulate;
    key.transpose = transpose;
    key.clip_uv = clip_uv;
    log_entry(&g_texture_rect_regions, pod(key));
  }
  original<FnAddTextureRectRegion>(kAddTextureRectRegion)(self, item, rect, texture, source,
                                                          modulate, transpose, clip_uv);
}

void hook_add_msdf_texture_rect_region(void *self, RID item, const Rect2 *rect, RID texture,
                                       const Rect2 *source, const Color *modulate,
                                       int outline_size, float px_range, float scale) {
  bump(kAddMsdfTextureRectRegion);
  rs::adopt_texture_ref(texture.id);  // G8r: a pre-arm texture is adopted at first reference
  // G4e2 (gate4-design.md Q3 "MSDF tap"): the /3 command, no longer a typed refusal.
  if (streaming() && rect != nullptr && source != nullptr && modulate != nullptr) {
    mirror().add_msdf_texture_rect_region(item.id, to_rect(*rect), texture.id, to_rect(*source),
                                          to_color(*modulate), outline_size, px_range, scale,
                                          current_frame());
  }
  if (rect != nullptr && source != nullptr && modulate != nullptr) {
    MsdfRectKey key;
    zero(&key);
    key.item = item.id;
    key.rect = *rect;
    key.texture = texture.id;
    key.source = *source;
    key.modulate = *modulate;
    key.outline_size = outline_size;
    key.px_range = px_range;
    key.scale = scale;
    log_entry(&g_msdf_rects, pod(key));
  }
  original<FnAddMsdfTextureRectRegion>(kAddMsdfTextureRectRegion)(
      self, item, rect, texture, source, modulate, outline_size, px_range, scale);
}

void hook_add_polygon(void *self, RID item, const Vector<Point2> *points,
                      const Vector<Color> *colors, const Vector<Point2> *uvs, RID texture) {
  bump(kAddPolygon);
  rs::adopt_texture_ref(texture.id);  // G8r: a pre-arm texture is adopted at first reference
  if (streaming()) {
    mirror().add_primitive(item.id, whole_points(points), whole_colors(colors), whole_points(uvs),
                           texture.id, /*polygon=*/true, current_frame());
  }
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_polygons.size() < kMaxPolygons) {
      PolygonCapture capture;
      capture.item = item.id;
      capture.texture = texture.id;
      capture.points_total = points != nullptr ? points->size() : 0;
      capture.colors_total = colors != nullptr ? colors->size() : 0;
      capture.uvs_count = uvs != nullptr ? uvs->size() : 0;
      const int64_t point_limit = capture.points_total < static_cast<int64_t>(kMaxPolygonPoints)
                                      ? capture.points_total
                                      : static_cast<int64_t>(kMaxPolygonPoints);
      for (int64_t i = 0; i < point_limit; ++i) {
        capture.points.push_back(points->ptr()[i]);
      }
      const int64_t color_limit = capture.colors_total < static_cast<int64_t>(kMaxPolygonPoints)
                                      ? capture.colors_total
                                      : static_cast<int64_t>(kMaxPolygonPoints);
      for (int64_t i = 0; i < color_limit; ++i) {
        capture.colors.push_back(colors->ptr()[i]);
      }
      g_polygons.push_back(capture);
    }
  }
  original<FnAddPolygon>(kAddPolygon)(self, item, points, colors, uvs, texture);
}

// --- G8kc: texture_set_path (texture-delivery-design.md D10) ----------------------------------
//
// The engine calls texture_set_path(rid, "res://...") right after texture_2d_create on the loading
// thread (compressed_texture.cpp:91-96, :158-161), so the path of a texture is known to the hook.
// The hook is installed only under GRC_TEXTURE_CACHE_DIR (the cache is what uses it), keeps the
// path per texture, and reports it with the texture's D7 source key and cache outcome in
// evidence/texture-cache.json, and every call in counters.json `captured.texture_set_path`.

struct CacheNote {
  rs::PayloadCopy copy;
  rs::TextureJobPtr job;
};

std::mutex g_cache_mutex;
std::map<uint64_t, CacheNote> g_cache_notes;
std::map<uint64_t, std::string> g_texture_paths;  // the last path set per texture
std::vector<std::pair<uint64_t, std::string>> g_set_path_calls;

// Keeps only the small facts the evidence needs: the payload bytes (the block variant's, the
// worker job's) must not stay alive for the session through this registry.
void slim_note(CacheNote *note) {
  note->copy.block_bytes.reset();
}

// Resolves a finished job into its note (source key, outcome, status, hash) and drops the job, and
// with it the payload bytes the job holds. Under g_cache_mutex.
void resolve_note(CacheNote *note) {
  if (note->job != nullptr && note->job->done()) {
    note->job->fill(&note->copy);
    note->copy.status = note->job->actual().status;
    note->job.reset();
    slim_note(note);
  }
}

std::vector<uint64_t> g_cache_pending;  // ids whose job was not done when last looked at

void note_cache_texture(uint64_t id, const rs::PayloadCopy &copy, const rs::TextureJobPtr &job) {
  if (!rs::texture_cache().enabled()) {
    return;
  }
  std::lock_guard<std::mutex> lock(g_cache_mutex);
  // Sweep the jobs that finished since the last texture, so a long session holds none of them.
  std::vector<uint64_t> still;
  for (uint64_t pending : g_cache_pending) {
    auto it = g_cache_notes.find(pending);
    if (it == g_cache_notes.end()) continue;
    resolve_note(&it->second);
    if (it->second.job != nullptr) still.push_back(pending);
  }
  g_cache_pending.swap(still);
  if (g_cache_notes.size() < kMaxTextures) {
    CacheNote note{copy, job};
    slim_note(&note);
    resolve_note(&note);
    if (note.job != nullptr) g_cache_pending.push_back(id);
    g_cache_notes[id] = std::move(note);
  }
}

void hook_texture_set_path(void *self, RID texture, const void *path) {
  bump(kTextureSetPath);
  const std::string text = rs::decode_string(path);
  {
    std::lock_guard<std::mutex> lock(g_cache_mutex);
    g_texture_paths[texture.id] = text;
    if (g_set_path_calls.size() < kMaxTextures) {
      g_set_path_calls.emplace_back(texture.id, text);
    }
  }
  original<FnTextureSetPath>(kTextureSetPath)(self, texture, path);
}

RID hook_texture_2d_create(void *self, const Ref *image) {
  bump(kTexture2dCreate);
  const uint64_t t_hook = now_ns();
  const ImageFacts facts = read_image(image);
  ImageCapture capture = describe_image(facts, 0, -1);
  // D3: the bytes are copied and hashed here, on the calling thread, before the
  // engine sees the call (a worker-thread create is initialized later, from
  // whatever the Image then holds). G8kw: or, under GRC_TEXTURE_WORKERS=<N>, a copy-on-write
  // duplicate taken here is copied and hashed by a worker.
  const bool logging = resources().active();
  rs::PayloadPtr bytes;
  rs::TextureJobPtr job;
  rs::PayloadCopy copy = logging ? copy_payload(facts, image, &bytes, &job) : rs::PayloadCopy();
  const uint64_t t_forward = now_ns();
  const RID result = original<FnTexture2dCreate>(kTexture2dCreate)(self, image);
  const uint64_t forward_ns = now_ns() - t_forward;
  capture.rid = result.id;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_creates.size() < kMaxTextures) {
      g_creates.push_back(capture);
    }
  }
  if (logging) {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("texture_2d_create");
    if (streaming() && !omit) {
      mirror().texture_2d_create(result.id, copy, std::move(bytes), current_frame(), job);
    }
    if (job != nullptr) {
      copy.hook_ns = static_cast<int64_t>(now_ns() - t_hook - forward_ns);
    }
    resources().texture_2d_create(tap_context(), result.id, copy, omit, job);
    note_cache_texture(result.id, copy, job);
  }
  return result;
}

void hook_texture_2d_update(void *self, RID texture, const Ref *image, int layer) {
  bump(kTexture2dUpdate);
  const uint64_t t_hook = now_ns();
  const ImageFacts facts = read_image(image);
  {
    ImageCapture capture = describe_image(facts, texture.id, layer);
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_updates.size() < kMaxTextures) {
      g_updates.push_back(capture);
    }
  }
  const bool logging = resources().active();
  rs::PayloadPtr bytes;
  rs::TextureJobPtr job;
  rs::PayloadCopy copy = logging ? copy_payload(facts, image, &bytes, &job) : rs::PayloadCopy();
  const uint64_t t_forward = now_ns();
  original<FnTexture2dUpdate>(kTexture2dUpdate)(self, texture, image, layer);
  const uint64_t forward_ns = now_ns() - t_forward;
  if (logging) {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("texture_2d_update");
    // G8r (gate8-design.md D6, D7): the first reference to a pre-arm texture is this whole-image
    // update (an atlas page growing, an ImageTexture.update): adopt it with the update's own
    // image as its content, `current`; the update below then applies as for any known texture.
    if (rs::adopt_resources_active() && streaming() && !omit && layer == 0 &&
        !mirror().knows_texture(texture.id) && rs::adopt_from_update_begin()) {
      if (job != nullptr) {
        copy.hook_ns = static_cast<int64_t>(now_ns() - t_hook - forward_ns);
      }
      mirror().texture_adopt(texture.id, copy, bytes, rs2::AdoptedContent::Current,
                             current_frame(), job);
      resources().texture_adopt(tap_context(), texture.id, copy, "current", "update", job);
    }
    if (streaming() && !omit) {
      mirror().texture_2d_update(texture.id, copy, std::move(bytes), layer, current_frame(), job);
    }
    if (job != nullptr) {
      copy.hook_ns = static_cast<int64_t>(now_ns() - t_hook - forward_ns);
    }
    resources().texture_2d_update(tap_context(), texture.id, copy, layer, omit, job);
  }
}

void hook_free(void *self, RID rid) {
  if (t_internal) {  // G8m (D4): the temporary Shader's RID
    original<FnFree>(kFree)(self, rid);
    return;
  }
  bump(kFree);
  log_entry(&g_frees, rids(rid.id));
  // A private CanvasTexture RID of the headless shim is recorded, then forwarded like any other:
  // every owner of the dummy server rejects its index silently (rs_canvas_texture_shim.h).
  rs::canvas_texture_shim().on_free(rid.id, current_frame());
  {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("free");
    if (streaming()) {
      // Before forwarding, so the mapping is gone before the engine can hand the
      // value out again. (The mirror applies omit-op `free` itself.)
      mirror().free_rid(rid.id, current_frame());
    }
    // Likewise for the texture and mesh hook logs, which log only RIDs they know.
    resources().free_rid(tap_context(), rid.id, omit);
    if (resources().active()) {
      // G5a: the hook's own retained mesh-buffer cache leaves with the mesh, omit-op included --
      // a stale free is the same contradiction a stale texture update is, left to show as pixels.
      std::lock_guard<std::mutex> lock(g_mutex);
      if (!omit) {
        g_mesh_buffers.erase(rid.id);
      }
    }
  }
  original<FnFree>(kFree)(self, rid);
}

// --- optional hooks ----------------------------------------------------------

void hook_add_triangle_array(void *self, RID item, const Vector<int32_t> *indices,
                             const Vector<Point2> *points, const Vector<Color> *colors,
                             const Vector<Point2> *uvs, const Vector<int32_t> *bones,
                             const Vector<float> *weights, RID texture, int count) {
  bump(kAddTriangleArray);
  rs::adopt_texture_ref(texture.id);  // G8r: a pre-arm texture is adopted at first reference
  if (streaming()) {
    const bool skinned =
        (bones != nullptr && bones->size() > 0) || (weights != nullptr && weights->size() > 0);
    mirror().add_triangle_array(item.id, skinned ? std::vector<int32_t>() : whole_ints(indices),
                                skinned ? std::vector<rs2::Point2>() : whole_points(points),
                                skinned ? std::vector<rs2::Color4>() : whole_colors(colors),
                                skinned ? std::vector<rs2::Point2>() : whole_points(uvs), skinned,
                                texture.id, count, current_frame());
  }
  GeometryEntry entry;
  entry.item = item.id;
  entry.indices_total = copy_head(indices, &entry.indices);
  entry.points_total = copy_head(points, &entry.points);
  entry.colors_total = copy_head(colors, &entry.colors);
  entry.uvs_total = copy_head(uvs, &entry.uvs);
  entry.bones_total = bones != nullptr ? bones->size() : 0;
  entry.weights_total = weights != nullptr ? weights->size() : 0;
  entry.texture = texture.id;
  entry.count = count;
  log_entry(&g_triangle_arrays, std::move(entry));
  original<FnAddTriangleArray>(kAddTriangleArray)(self, item, indices, points, colors, uvs, bones,
                                                  weights, texture, count);
}

void hook_add_mesh(void *self, RID item, const RID *mesh, const Transform2D *transform,
                   const Color *modulate, RID texture) {
  bump(kAddMesh);
  if (mesh != nullptr) {
    rs::adopt_mesh_ref(mesh->id);  // G8r: a pre-arm mesh is adopted at first reference
  }
  rs::adopt_texture_ref(texture.id);
  // G5e (gate5-design.md Q3b, render-stream-4.md "Command"): the /4 add_mesh command, naming the
  // mirror's mesh table entry (an unknown mesh RID becomes `unsupported`/`unknown-mesh`).
  if (streaming()) {
    if (mesh != nullptr && transform != nullptr && modulate != nullptr) {
      mirror().add_mesh(item.id, mesh->id, to_xform(*transform), to_color(*modulate), texture.id,
                        current_frame());
    } else {
      tap_unsupported(item, "canvas_item_add_mesh");
    }
  }
  if (mesh != nullptr && transform != nullptr && modulate != nullptr) {
    AddMeshKey key;
    zero(&key);
    key.item = item.id;
    key.mesh = mesh->id;
    key.transform = *transform;
    key.modulate = *modulate;
    key.texture = texture.id;
    log_entry(&g_add_meshes, pod(key));
  }
  original<FnAddMesh>(kAddMesh)(self, item, mesh, transform, modulate, texture);
}

void hook_add_multimesh(void *self, RID item, RID mesh, RID texture) {
  bump(kAddMultimesh);
  tap_unsupported(item, "canvas_item_add_multimesh");
  log_entry(&g_add_multimeshes, rids(item.id, mesh.id, texture.id));
  original<FnAddMultimesh>(kAddMultimesh)(self, item, mesh, texture);
}

void hook_add_nine_patch(void *self, RID item, const Rect2 *rect, const Rect2 *source,
                         RID texture, const Vector2 *topleft, const Vector2 *bottomright,
                         int32_t x_axis_mode, int32_t y_axis_mode, bool draw_center,
                         const Color *modulate) {
  bump(kAddNinePatch);
  rs::adopt_texture_ref(texture.id);  // G8r: a pre-arm texture is adopted at first reference
  if (streaming() && rect != nullptr && source != nullptr && topleft != nullptr &&
      bottomright != nullptr && modulate != nullptr) {
    mirror().add_nine_patch(item.id, to_rect(*rect), to_rect(*source), texture.id,
                            to_point(*topleft), to_point(*bottomright), x_axis_mode, y_axis_mode,
                            draw_center, to_color(*modulate), current_frame());
  }
  if (rect != nullptr && source != nullptr && topleft != nullptr && bottomright != nullptr &&
      modulate != nullptr) {
    NinePatchKey key;
    zero(&key);
    key.item = item.id;
    key.rect = *rect;
    key.source = *source;
    key.texture = texture.id;
    key.topleft = *topleft;
    key.bottomright = *bottomright;
    key.x_axis_mode = x_axis_mode;
    key.y_axis_mode = y_axis_mode;
    key.modulate = *modulate;
    key.draw_center = draw_center;
    log_entry(&g_nine_patches, pod(key));
  }
  original<FnAddNinePatch>(kAddNinePatch)(self, item, rect, source, texture, topleft, bottomright,
                                          x_axis_mode, y_axis_mode, draw_center, modulate);
}

void hook_add_primitive(void *self, RID item, const Vector<Point2> *points,
                        const Vector<Color> *colors, const Vector<Point2> *uvs, RID texture) {
  bump(kAddPrimitive);
  rs::adopt_texture_ref(texture.id);  // G8r: a pre-arm texture is adopted at first reference
  if (streaming()) {
    mirror().add_primitive(item.id, whole_points(points), whole_colors(colors), whole_points(uvs),
                           texture.id, /*polygon=*/false, current_frame());
  }
  GeometryEntry entry;
  entry.item = item.id;
  entry.points_total = copy_head(points, &entry.points);
  entry.colors_total = copy_head(colors, &entry.colors);
  entry.uvs_total = copy_head(uvs, &entry.uvs);
  entry.texture = texture.id;
  log_entry(&g_primitives, std::move(entry));
  original<FnAddPrimitive>(kAddPrimitive)(self, item, points, colors, uvs, texture);
}

void hook_add_line(void *self, RID item, const Point2 *from, const Point2 *to, const Color *color,
                   float width, bool antialiased) {
  bump(kAddLine);
  if (streaming() && from != nullptr && to != nullptr && color != nullptr) {
    mirror().add_line(item.id, to_point(*from), to_point(*to), to_color(*color), width,
                      antialiased, current_frame());
  }
  if (from != nullptr && to != nullptr && color != nullptr) {
    LineKey key;
    zero(&key);
    key.item = item.id;
    key.from = *from;
    key.to = *to;
    key.color = *color;
    key.width = width;
    key.antialiased = antialiased;
    log_entry(&g_lines, pod(key));
  }
  original<FnAddLine>(kAddLine)(self, item, from, to, color, width, antialiased);
}

void hook_add_polyline(void *self, RID item, const Vector<Point2> *points,
                       const Vector<Color> *colors, float width, bool antialiased) {
  bump(kAddPolyline);
  if (streaming()) {
    mirror().add_polyline(item.id, whole_points(points), whole_colors(colors), width, antialiased,
                          /*multiline=*/false, current_frame());
  }
  GeometryEntry entry;
  entry.item = item.id;
  entry.points_total = copy_head(points, &entry.points);
  entry.colors_total = copy_head(colors, &entry.colors);
  entry.width = width;
  entry.antialiased = antialiased;
  log_entry(&g_polylines, std::move(entry));
  original<FnAddPolyline>(kAddPolyline)(self, item, points, colors, width, antialiased);
}

void hook_add_circle(void *self, RID item, const Point2 *position, float radius,
                     const Color *color, bool antialiased) {
  bump(kAddCircle);
  if (streaming() && position != nullptr && color != nullptr) {
    mirror().add_circle(item.id, to_point(*position), radius, to_color(*color), antialiased,
                        current_frame());
  }
  if (position != nullptr && color != nullptr) {
    CircleKey key;
    zero(&key);
    key.item = item.id;
    key.position = *position;
    key.radius = radius;
    key.color = *color;
    key.antialiased = antialiased;
    log_entry(&g_circles, pod(key));
  }
  original<FnAddCircle>(kAddCircle)(self, item, position, radius, color, antialiased);
}

PodEntry<ItemTransformKey> item_transform(RID item, const Transform2D &transform) {
  ItemTransformKey key;
  zero(&key);
  key.item = item.id;
  key.transform = transform;
  return pod(key);
}

void hook_add_set_transform(void *self, RID item, const Transform2D *transform) {
  bump(kAddSetTransform);
  if (streaming() && transform != nullptr) {
    mirror().add_set_transform(item.id, to_xform(*transform), current_frame());
  }
  if (transform != nullptr) {
    log_entry(&g_add_set_transforms, item_transform(item, *transform));
  }
  original<FnItemTransform>(kAddSetTransform)(self, item, transform);
}

void hook_set_transform(void *self, RID item, const Transform2D *transform) {
  bump(kSetTransform);
  if (transform != nullptr) {
    log_entry(&g_set_transforms, item_transform(item, *transform));
    if (streaming()) {
      mirror().set_transform(item.id, to_xform(*transform), current_frame());
    }
  }
  original<FnItemTransform>(kSetTransform)(self, item, transform);
}

void hook_set_modulate(void *self, RID item, const Color *color) {
  bump(kSetModulate);
  if (color != nullptr) {
    ItemColorKey key;
    zero(&key);
    key.item = item.id;
    key.color = *color;
    log_entry(&g_set_modulates, pod(key));
    if (streaming()) {
      mirror().set_modulate(item.id, to_color(*color), current_frame());
    }
  }
  original<FnSetModulate>(kSetModulate)(self, item, color);
}

RID hook_canvas_item_create(void *self) {
  bump(kCanvasItemCreate);
  const RID result = original<FnCreate>(kCanvasItemCreate)(self);
  log_entry(&g_canvas_item_creates, rids(result.id));
  if (streaming()) {
    mirror().canvas_item_create(result.id, current_frame());
  }
  return result;
}

void hook_canvas_item_clear(void *self, RID item) {
  bump(kCanvasItemClear);
  log_entry(&g_canvas_item_clears, rids(item.id));
  if (streaming()) {
    mirror().clear(item.id, current_frame());
  }
  original<FnRidOnly>(kCanvasItemClear)(self, item);
}

void hook_set_material(void *self, RID item, RID material) {
  bump(kSetMaterial);
  log_entry(&g_set_materials, rids(item.id, material.id));
  if (streaming()) {
    mirror().set_material(item.id, material.id, current_frame());
  }
  // Logged for the material census (gate5_5-design.md Q3d) alongside calibrator 8's own taps;
  // since G55d the mirror keeps it as the item's `material` field (D9).
  if (resources().active()) {
    resources().canvas_item_set_material(tap_context(), item.id, material.id);
  }
  original<FnSetMaterial>(kSetMaterial)(self, item, material);
}

RID hook_mesh_create(void *self) {
  bump(kMeshCreate);
  const RID result = original<FnCreate>(kMeshCreate)(self);
  log_entry(&g_mesh_creates, rids(result.id));
  const bool logging = resources().active();
  if (logging) {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("mesh_create");
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!omit) {
      g_mesh_buffers[result.id];  // an empty surface list, value-initialized
    }
    if (streaming()) {
      mirror().mesh_create(result.id, current_frame());  // G5e: the mesh table (omit-op inside)
    }
    resources().mesh_create(tap_context(), result.id, omit);
  }
  return result;
}

void hook_mesh_add_surface(void *self, RID mesh, const SurfaceDataPrefix *surface) {
  bump(kMeshAddSurface);
  if (surface != nullptr) {
    MeshSurfaceKey key;
    zero(&key);
    key.mesh = mesh.id;
    key.primitive = surface->primitive;
    key.format = surface->format;
    key.vertex_data_size = surface->vertex_data.size();
    key.attribute_data_size = surface->attribute_data.size();
    key.skin_data_size = surface->skin_data.size();
    key.vertex_count = surface->vertex_count;
    key.index_data_size = surface->index_data.size();
    key.index_count = surface->index_count;
    key.aabb = surface->aabb;
    log_entry(&g_mesh_surfaces, pod(key));
  }
  // Gate 5 (G5a, D6): whole-surface copy at the hook, classified (D7), hashed into a GRM1
  // payload, and appended to the hook's own retained-buffer cache (so a later region update can
  // re-hash the whole surface) and to evidence/resources.jsonl.
  if (surface != nullptr && resources().active()) {
    MeshSurfaceBuffer buffer;
    rs::MeshSurfaceInput input;
    input.copy = copy_mesh_surface(*surface, &buffer, &input.bytes);
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("mesh_add_surface");
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!omit) {
      g_mesh_buffers[mesh.id].push_back(std::move(buffer));
    }
    if (streaming()) {
      mirror().mesh_add_surface(mesh.id, input, current_frame());
    }
    resources().mesh_add_surface(tap_context(), mesh.id, input.copy, omit);
  }
  original<FnMeshAddSurface>(kMeshAddSurface)(self, mesh, surface);
}

PodEntry<RegionKey> region(RID mesh, int surface, int offset, const Vector<uint8_t> *data) {
  RegionKey key;
  zero(&key);
  key.mesh = mesh.id;
  key.surface = surface;
  key.offset = offset;
  key.data_size = data != nullptr ? data->size() : 0;
  const int64_t head = key.data_size < static_cast<int64_t>(kMaxRegionBytes)
                           ? key.data_size
                           : static_cast<int64_t>(kMaxRegionBytes);
  if (head > 0) {
    std::memcpy(key.head, data->ptr(), static_cast<size_t>(head));
  }
  key.head_size = static_cast<uint32_t>(head > 0 ? head : 0);
  return pod(key);
}

// Gate 5 (G5a, D6, D8, Q3a): one of the four mesh_surface_update_*_region hooks. `which` selects
// the retained buffer; the counters.json capture (`region()` above) is unchanged -- it still
// keeps only a 64-byte head for deduplication -- but the hook's own copy for resources.jsonl is
// always the whole `p_data` applied in place, as D6 requires. Bounds are checked exactly as
// GLES3 would (gles3m:536-594): out of range or empty is "rejected" and changes nothing; an
// unknown mesh or surface index is "unknown"; a surface already `unsupported` (D7) only bumps the
// version (gate5-design.md Q3b). The omit-op sabotage (G5d) leaves the retained bytes stale, as
// for a texture.
enum class MeshBuffer { kVertex, kAttribute, kSkin, kIndex };

const char *mesh_buffer_name(MeshBuffer which) {
  switch (which) {
    case MeshBuffer::kVertex:
      return "vertex";
    case MeshBuffer::kAttribute:
      return "attribute";
    case MeshBuffer::kSkin:
      return "skin";
    case MeshBuffer::kIndex:
      return "index";
  }
  return "";
}

const char *mesh_region_op_name(MeshBuffer which) {
  switch (which) {
    case MeshBuffer::kVertex:
      return "mesh_surface_update_vertex_region";
    case MeshBuffer::kAttribute:
      return "mesh_surface_update_attribute_region";
    case MeshBuffer::kSkin:
      return "mesh_surface_update_skin_region";
    case MeshBuffer::kIndex:
      return "mesh_surface_update_index_region";
  }
  return "";
}

std::vector<uint8_t> *mesh_buffer_field(MeshSurfaceBuffer *buffer, MeshBuffer which) {
  switch (which) {
    case MeshBuffer::kVertex:
      return &buffer->vertex_data;
    case MeshBuffer::kAttribute:
      return &buffer->attribute_data;
    case MeshBuffer::kSkin:
      return &buffer->skin_data;
    case MeshBuffer::kIndex:
      return &buffer->index_data;
  }
  return nullptr;
}

void handle_mesh_region_update(MeshBuffer which, RID mesh, int32_t surface, int32_t offset,
                               const Vector<uint8_t> *data) {
  if (!resources().active()) {
    return;
  }
  const int64_t bytes = data != nullptr ? data->size() : 0;
  std::lock_guard<std::mutex> order(g_texture_order);
  const bool omit = omitted(mesh_region_op_name(which));
  std::lock_guard<std::mutex> lock(g_mutex);
  const char *outcome = "unknown";
  rs::MeshSurfaceInput updated;
  const rs::MeshSurfaceInput *new_surface = nullptr;
  auto it = g_mesh_buffers.find(mesh.id);
  if (it != g_mesh_buffers.end() && surface >= 0 &&
      static_cast<size_t>(surface) < it->second.size()) {
    MeshSurfaceBuffer &buffer = it->second[static_cast<size_t>(surface)];
    if (!buffer.ok) {
      outcome = "applied";  // Q3b: an already-unsupported surface only bumps the version.
    } else {
      std::vector<uint8_t> *field = mesh_buffer_field(&buffer, which);
      const bool in_bounds = data != nullptr && bytes > 0 && offset >= 0 &&
                             static_cast<uint64_t>(offset) + static_cast<uint64_t>(bytes) <=
                                 field->size();
      if (!in_bounds) {
        outcome = "rejected";
      } else {
        outcome = "applied";
        if (!omit) {
          std::memcpy(field->data() + offset, data->ptr(), static_cast<size_t>(bytes));
          updated.copy = rehash_mesh_surface(buffer, &updated.bytes);
          new_surface = &updated;
        }
      }
    }
  }
  if (streaming()) {
    // G5e: the mirror takes the hook's verdict (D8) and the re-encoded whole surface.
    mirror().mesh_surface_update_region(mesh.id, mesh_region_op_name(which), surface,
                                        std::string(outcome) == "applied", new_surface,
                                        current_frame());
  }
  resources().mesh_surface_update_region(tap_context(), mesh.id, mesh_buffer_name(which), surface,
                                         offset, bytes, outcome,
                                         new_surface != nullptr ? &new_surface->copy : nullptr,
                                         omit);
}

void hook_mesh_update_vertex_region(void *self, RID mesh, int surface, int offset,
                                    const Vector<uint8_t> *data) {
  bump(kMeshUpdateVertexRegion);
  log_entry(&g_vertex_regions, region(mesh, surface, offset, data));
  handle_mesh_region_update(MeshBuffer::kVertex, mesh, surface, offset, data);
  original<FnMeshUpdateRegion>(kMeshUpdateVertexRegion)(self, mesh, surface, offset, data);
}

void hook_mesh_update_attribute_region(void *self, RID mesh, int surface, int offset,
                                       const Vector<uint8_t> *data) {
  bump(kMeshUpdateAttributeRegion);
  log_entry(&g_attribute_regions, region(mesh, surface, offset, data));
  handle_mesh_region_update(MeshBuffer::kAttribute, mesh, surface, offset, data);
  original<FnMeshUpdateRegion>(kMeshUpdateAttributeRegion)(self, mesh, surface, offset, data);
}

void hook_mesh_clear(void *self, RID mesh) {
  bump(kMeshClear);
  log_entry(&g_mesh_clears, rids(mesh.id));
  if (resources().active()) {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("mesh_clear");
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!omit) {
      auto it = g_mesh_buffers.find(mesh.id);
      if (it != g_mesh_buffers.end()) {
        it->second.clear();
      }
    }
    if (streaming()) {
      mirror().mesh_clear(mesh.id, current_frame());
    }
    resources().mesh_clear(tap_context(), mesh.id, omit);
  }
  original<FnRidOnly>(kMeshClear)(self, mesh);
}

void hook_mesh_set_custom_aabb(void *self, RID mesh, const AABB *aabb) {
  bump(kMeshSetCustomAabb);
  if (aabb != nullptr) {
    MeshAabbKey key;
    zero(&key);
    key.mesh = mesh.id;
    key.aabb = *aabb;
    log_entry(&g_mesh_aabbs, pod(key));
  }
  if (resources().active()) {
    std::lock_guard<std::mutex> order(g_texture_order);
    if (streaming() && aabb != nullptr) {
      // G5e: the mesh entry's custom AABB (position xyz, size xyz).
      mirror().mesh_set_custom_aabb(mesh.id,
                                    {aabb->position.x, aabb->position.y, aabb->position.z,
                                     aabb->size.x, aabb->size.y, aabb->size.z},
                                    current_frame());
    }
    resources().mesh_set_custom_aabb(tap_context(), mesh.id, omitted("mesh_set_custom_aabb"));
  }
  original<FnMeshSetCustomAabb>(kMeshSetCustomAabb)(self, mesh, aabb);
}

// --- calibrator 7 hooks (gate5-design.md Q2) --------------------------------

// mesh_create_from_surfaces: RenderingServerDefault allocates and adds every surface directly in
// mesh storage (rsd.h:332-356), so neither mesh_create nor mesh_add_surface is called through the
// vtable -- this is the ONLY place a loaded ArrayMesh's surfaces are seen. Each surface is copied,
// classified and hashed exactly as a plain mesh_add_surface's is.
RID hook_mesh_create_from_surfaces(void *self, const Vector<SurfaceDataPrefix> *surfaces,
                                   int32_t blend_shape_count) {
  bump(kMeshCreateFromSurfaces);
  const RID result =
      original<FnMeshCreateFromSurfaces>(kMeshCreateFromSurfaces)(self, surfaces, blend_shape_count);
  log_entry(&g_mesh_create_from_surfaces_calls,
           rids(result.id, surfaces != nullptr ? static_cast<uint64_t>(surfaces->size()) : 0));
  if (resources().active()) {
    std::vector<MeshSurfaceBuffer> buffers;
    std::vector<rs::MeshSurfaceInput> inputs;
    std::vector<rs::MeshSurfaceCopy> copies;
    const int64_t count = surfaces != nullptr ? surfaces->size() : 0;
    for (int64_t i = 0; i < count; ++i) {
      MeshSurfaceBuffer buffer;
      rs::MeshSurfaceInput input;
      input.copy = copy_mesh_surface(surfaces->ptr()[i], &buffer, &input.bytes);
      copies.push_back(input.copy);
      inputs.push_back(std::move(input));
      buffers.push_back(std::move(buffer));
    }
    // A loader thread may get here (gate5-design.md Q1j): the identity lock orders it against
    // the main thread's mesh taps for the mirror and the log alike.
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("mesh_create_from_surfaces");
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!omit) {
      g_mesh_buffers[result.id] = std::move(buffers);
    }
    if (streaming()) {
      mirror().mesh_create_from_surfaces(result.id, inputs, current_frame());
    }
    resources().mesh_create_from_surfaces(tap_context(), result.id, copies, omit);
  }
  return result;
}

void hook_mesh_update_skin_region(void *self, RID mesh, int surface, int offset,
                                  const Vector<uint8_t> *data) {
  bump(kMeshUpdateSkinRegion);
  log_entry(&g_skin_regions, region(mesh, surface, offset, data));
  handle_mesh_region_update(MeshBuffer::kSkin, mesh, surface, offset, data);
  original<FnMeshUpdateRegion>(kMeshUpdateSkinRegion)(self, mesh, surface, offset, data);
}

void hook_mesh_update_index_region(void *self, RID mesh, int surface, int offset,
                                   const Vector<uint8_t> *data) {
  bump(kMeshUpdateIndexRegion);
  log_entry(&g_index_regions, region(mesh, surface, offset, data));
  handle_mesh_region_update(MeshBuffer::kIndex, mesh, surface, offset, data);
  original<FnMeshUpdateRegion>(kMeshUpdateIndexRegion)(self, mesh, surface, offset, data);
}

void hook_mesh_surface_remove(void *self, RID mesh, int surface) {
  bump(kMeshSurfaceRemove);
  log_entry(&g_mesh_surface_removes, item_value(mesh, surface));
  if (resources().active()) {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("mesh_surface_remove");
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!omit) {
      auto it = g_mesh_buffers.find(mesh.id);
      if (it != g_mesh_buffers.end() && surface >= 0 &&
          static_cast<size_t>(surface) < it->second.size()) {
        it->second.erase(it->second.begin() + surface);
      }
    }
    if (streaming()) {
      mirror().mesh_surface_remove(mesh.id, surface, current_frame());
    }
    resources().mesh_surface_remove(tap_context(), mesh.id, surface, omit);
  }
  original<FnRidInt>(kMeshSurfaceRemove)(self, mesh, surface);
}

// canvas_item_add_multiline: draw_multiline and draw_dashed_line's dashes (ci.cpp:697-731,
// :771-784) reach this hook, which was unhooked before calibrator 7 and silently dropped both
// (rs-gate5-geometry-engine-facts). Typed unsupported until /4; since G5d the /4 add_multiline
// command (whole arrays); counters.json is truncated like every other optional geometry op.
void hook_add_multiline(void *self, RID item, const Vector<Point2> *points,
                        const Vector<Color> *colors, float width, bool antialiased) {
  bump(kAddMultiline);
  if (streaming()) {
    mirror().add_polyline(item.id, whole_points(points), whole_colors(colors), width, antialiased,
                          /*multiline=*/true, current_frame());
  }
  GeometryEntry entry;
  entry.item = item.id;
  entry.points_total = copy_head(points, &entry.points);
  entry.colors_total = copy_head(colors, &entry.colors);
  entry.width = width;
  entry.antialiased = antialiased;
  log_entry(&g_multilines, std::move(entry));
  original<FnAddPolyline>(kAddMultiline)(self, item, points, colors, width, antialiased);
}

void hook_add_particles(void *self, RID item, RID particles, RID texture) {
  bump(kAddParticles);
  tap_unsupported(item, "canvas_item_add_particles");
  log_entry(&g_add_particles, rids(item.id, particles.id, texture.id));
  original<FnAddMultimesh>(kAddParticles)(self, item, particles, texture);
}

void hook_add_animation_slice(void *self, RID item, double animation_length, double slice_begin,
                              double slice_end, double offset) {
  bump(kAddAnimationSlice);
  tap_unsupported(item, "canvas_item_add_animation_slice");
  AnimationSliceKey key;
  zero(&key);
  key.item = item.id;
  key.animation_length = static_cast<float>(animation_length);
  key.slice_begin = static_cast<float>(slice_begin);
  key.slice_end = static_cast<float>(slice_end);
  key.offset = static_cast<float>(offset);
  log_entry(&g_animation_slices, pod(key));
  original<FnAddAnimationSlice>(kAddAnimationSlice)(self, item, animation_length, slice_begin,
                                                    slice_end, offset);
}

// canvas_item_attach_skeleton: a null skeleton (Polygon2D's per-draw call, D1d) is free and
// leaves no trace; a non-null one is reported in Snapshot::unsupported only, as a non-null
// material is (D2, D16).
void hook_attach_skeleton(void *self, RID item, RID skeleton) {
  bump(kAttachSkeleton);
  log_entry(&g_attach_skeletons, rids(item.id, skeleton.id));
  if (streaming()) {
    mirror().attach_skeleton(item.id, skeleton.id, current_frame());
  }
  original<FnSetMaterial>(kAttachSkeleton)(self, item, skeleton);
}

RID hook_shader_create_from_code(void *self, const void *code, const void *path_hint) {
  if (t_internal) {  // G8m (D4): the capture's temporary Shader
    const RID made =
        original<FnShaderCreateFromCode>(kShaderCreateFromCode)(self, code, path_hint);
    if (t_internal_code != nullptr) {
      *t_internal_code = rs::decode_string(code);
    }
    if (t_internal_rid != nullptr) {
      *t_internal_rid = made.id;
    }
    return made;
  }
  bump(kShaderCreateFromCode);
  const RID result =
      original<FnShaderCreateFromCode>(kShaderCreateFromCode)(self, code, path_hint);
  log_entry(&g_shader_creates, rids(result.id));
  if (resources().active()) {
    rs::ShaderCodeInput input;
    input.copy = copy_shader_code(code, &input.bytes);
    // Loader threads create shaders too (Q1g): one order for the mirror's and the log's ids.
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("shader_create_from_code");
    if (streaming()) {
      mirror().shader_create_from_code(result.id, input, current_frame());  // omit-op inside
    }
    resources().shader_create_from_code(tap_context(), result.id, input.copy, omit);
  }
  return result;
}

void hook_shader_set_code(void *self, RID shader, const void *code) {
  if (t_internal) {  // G8m (D4)
    original<FnShaderSetCode>(kShaderSetCode)(self, shader, code);
    return;
  }
  bump(kShaderSetCode);
  log_entry(&g_shader_codes, rids(shader.id));
  if (resources().active()) {
    rs::ShaderCodeInput input;
    input.copy = copy_shader_code(code, &input.bytes);
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("shader_set_code");
    if (streaming()) {
      mirror().shader_set_code(shader.id, input, current_frame());
    }
    resources().shader_set_code(tap_context(), shader.id, input.copy, omit);
  }
  original<FnShaderSetCode>(kShaderSetCode)(self, shader, code);
}

void hook_material_set_param(void *self, RID material, const void *name, const void *value) {
  bump(kMaterialSetParam);
  log_entry(&g_material_params, rids(material.id));
  if (resources().active()) {
    const std::string param_name = rs::decode_string_name(name);
    rs::DecodedParam decoded;
    const rs::MaterialParamCopy copy = decode_material_param(value, &decoded);
    if (decoded.type == "rid" && decoded.status == "ok") {
      rs::adopt_texture_ref(decoded.tex_rid);  // G8r: a texture parameter naming a pre-arm texture
    }
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("material_set_param");
    if (streaming()) {
      mirror().material_set_param(material.id, param_name, decoded, current_frame());
    }
    resources().material_set_param(tap_context(), material.id, param_name, copy, omit);
  }
  original<FnMaterialSetParam>(kMaterialSetParam)(self, material, name, value);
}

// --- calibrator 8 hooks (gate5_5-design.md Q2) --------------------------------

RID hook_shader_create(void *self) {
  bump(kShaderCreate);
  const RID result = original<FnCreate>(kShaderCreate)(self);
  log_entry(&g_shader_create_calls, rids(result.id));
  if (resources().active()) {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("shader_create");
    if (streaming()) {
      mirror().shader_create(result.id, current_frame());
    }
    resources().shader_create(tap_context(), result.id, omit);
  }
  return result;
}

void hook_shader_set_default_texture_parameter(void *self, RID shader, const void *name,
                                               RID texture, int32_t index) {
  bump(kShaderSetDefaultTextureParameter);
  rs::adopt_texture_ref(texture.id);  // G8r
  ShaderDefaultTextureKey key;
  zero(&key);
  key.shader = shader.id;
  key.texture = texture.id;
  key.index = index;
  log_entry(&g_shader_default_textures, pod(key));
  if (resources().active()) {
    const std::string param_name = rs::decode_string_name(name);
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("shader_set_default_texture_parameter");
    if (streaming()) {
      mirror().shader_set_default_texture_parameter(shader.id, param_name, texture.id, index,
                                                    current_frame());
    }
    resources().shader_set_default_texture_parameter(tap_context(), shader.id, param_name,
                                                      texture.id, index, omit);
  }
  original<FnShaderSetDefaultTextureParameter>(kShaderSetDefaultTextureParameter)(
      self, shader, name, texture, index);
}

RID hook_material_create(void *self) {
  bump(kMaterialCreate);
  const RID result = original<FnCreate>(kMaterialCreate)(self);
  log_entry(&g_material_create_calls, rids(result.id));
  if (resources().active()) {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("material_create");
    if (streaming()) {
      mirror().material_create(result.id, current_frame());
    }
    resources().material_create(tap_context(), result.id, omit);
  }
  return result;
}

RID hook_material_create_from_shader(void *self, RID next_pass, int32_t priority, RID shader) {
  bump(kMaterialCreateFromShader);
  const RID result = original<FnMaterialCreateFromShader>(kMaterialCreateFromShader)(
      self, next_pass, priority, shader);
  MaterialShaderKey key;
  zero(&key);
  key.material = result.id;
  key.shader = shader.id;
  log_entry(&g_material_create_from_shader_calls, pod(key));
  if (resources().active()) {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("material_create_from_shader");
    if (streaming()) {
      mirror().material_create_from_shader(result.id, shader.id, current_frame());
    }
    resources().material_create_from_shader(tap_context(), result.id, shader.id, omit);
  }
  return result;
}

void hook_material_set_shader(void *self, RID material, RID shader) {
  bump(kMaterialSetShader);
  log_entry(&g_material_set_shaders, rids(material.id, shader.id));
  if (resources().active()) {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("material_set_shader");
    if (streaming()) {
      mirror().material_set_shader(material.id, shader.id, current_frame());
    }
    resources().material_set_shader(tap_context(), material.id, shader.id, omit);
  }
  original<FnSetMaterial>(kMaterialSetShader)(self, material, shader);
}

// canvas_set_modulate: the colour itself is not a material parameter (Q2's "never to
// counters.json" rule does not cover it), so it is captured fully here, as canvas_item_set_
// modulate/_self_modulate already are; the hook log's own line (kind:"item-material") is
// presence-only. Since G55d the mirror keeps it as the canvas's `modulate` (D10).
void hook_set_canvas_modulate(void *self, RID canvas, const Color *color) {
  bump(kSetCanvasModulate);
  if (color != nullptr) {
    ItemColorKey key;
    zero(&key);
    key.item = canvas.id;
    key.color = *color;
    log_entry(&g_canvas_set_modulates, pod(key));
    if (streaming()) {
      mirror().canvas_set_modulate(canvas.id, to_color(*color), current_frame());
    }
  }
  if (resources().active()) {
    resources().canvas_set_modulate(tap_context(), canvas.id);
  }
  original<FnSetModulate>(kSetCanvasModulate)(self, canvas, color);
}

void hook_set_use_parent_material(void *self, RID item, bool enable) {
  bump(kSetUseParentMaterial);
  log_entry(&g_set_use_parent_materials, item_value(item, enable ? 1 : 0));
  if (streaming()) {
    mirror().set_use_parent_material(item.id, enable, current_frame());
  }
  if (resources().active()) {
    resources().canvas_item_set_use_parent_material(tap_context(), item.id, enable);
  }
  original<FnRidBool>(kSetUseParentMaterial)(self, item, enable);
}

// canvas_item_set_instance_shader_parameter: counters.json keeps only the item RID (Q2); the
// decoded name and value go to the hook log alone.
void hook_set_instance_shader_parameter(void *self, RID item, const void *name,
                                        const void *value) {
  bump(kSetInstanceShaderParameter);
  log_entry(&g_set_instance_shader_parameters, rids(item.id));
  if (resources().active() || streaming()) {
    const std::string param_name = rs::decode_string_name(name);
    rs::DecodedParam decoded;
    const rs::MaterialParamCopy copy = decode_material_param(value, &decoded);
    if (decoded.type == "rid" && decoded.status == "ok") {
      rs::adopt_texture_ref(decoded.tex_rid);  // G8r
    }
    if (streaming()) {
      mirror().set_instance_shader_parameter(item.id, param_name, decoded, current_frame());
    }
    if (resources().active()) {
      resources().canvas_item_set_instance_shader_parameter(tap_context(), item.id, param_name,
                                                             copy);
    }
  }
  original<FnMaterialSetParam>(kSetInstanceShaderParameter)(self, item, name, value);
}

void hook_canvas_light_attach_to_canvas(void *self, RID light, RID canvas) {
  bump(kCanvasLightAttachToCanvas);
  log_entry(&g_canvas_light_attaches, rids(light.id, canvas.id));
  if (streaming()) {
    mirror().canvas_light_attach_to_canvas(light.id, canvas.id, current_frame());
  }
  if (resources().active()) {
    resources().canvas_light_attach_to_canvas(tap_context(), light.id, canvas.id);
  }
  original<FnSetMaterial>(kCanvasLightAttachToCanvas)(self, light, canvas);
}

// --- calibrator 9 hooks (gate6-design.md Q2): decoded and hook-logged since G6k, mirror taps
// since G6b (Q3b). ----------------------------------------------------------------------------

void hook_viewport_remove_canvas(void *self, RID viewport, RID canvas) {
  bump(kViewportRemoveCanvas);
  log_entry(&g_viewport_remove_canvases, rids(viewport.id, canvas.id));
  if (streaming()) {
    mirror().viewport_remove_canvas(viewport.id, canvas.id, current_frame());
  }
  if (resources().active()) {
    resources().viewport_remove_canvas(tap_context(), viewport.id, canvas.id);
  }
  original<FnSetMaterial>(kViewportRemoveCanvas)(self, viewport, canvas);
}

void hook_viewport_set_global_canvas_transform(void *self, RID viewport,
                                                const Transform2D *transform) {
  bump(kViewportSetGlobalCanvasTransform);
  if (transform != nullptr) {
    ViewportTransformKey key;
    zero(&key);
    key.viewport = viewport.id;
    key.transform = *transform;
    log_entry(&g_viewport_global_canvas_transforms, pod(key));
    if (streaming()) {
      mirror().viewport_set_global_canvas_transform(viewport.id, to_xform(*transform),
                                                    current_frame());
    }
    if (resources().active()) {
      resources().viewport_set_global_canvas_transform(tap_context(), viewport.id,
                                                        &transform->columns[0].x);
    }
  }
  original<FnViewportSetGlobalCanvasTransform>(kViewportSetGlobalCanvasTransform)(self, viewport,
                                                                                   transform);
}

void hook_viewport_set_canvas_stacking(void *self, RID viewport, RID canvas, int32_t layer,
                                        int32_t sublayer) {
  bump(kViewportSetCanvasStacking);
  CanvasStackingKey key;
  zero(&key);
  key.viewport = viewport.id;
  key.canvas = canvas.id;
  key.layer = layer;
  key.sublayer = sublayer;
  log_entry(&g_canvas_stackings, pod(key));
  if (streaming()) {
    mirror().viewport_set_canvas_stacking(viewport.id, canvas.id, layer, sublayer,
                                          current_frame());
  }
  if (resources().active()) {
    resources().viewport_set_canvas_stacking(tap_context(), viewport.id, canvas.id, layer,
                                              sublayer);
  }
  original<FnViewportSetCanvasStacking>(kViewportSetCanvasStacking)(self, viewport, canvas, layer,
                                                                     sublayer);
}

// canvas_set_item_mirroring's real ABI takes two RIDs (p_canvas, p_item); see the ABI comment
// block above.
void hook_canvas_set_item_mirroring(void *self, RID canvas, RID item, const Point2 *mirroring) {
  bump(kCanvasSetItemMirroring);
  if (mirroring != nullptr) {
    CanvasItemMirroringKey key;
    zero(&key);
    key.canvas = canvas.id;
    key.item = item.id;
    key.mirroring = *mirroring;
    log_entry(&g_canvas_item_mirrorings, pod(key));
    if (streaming()) {
      mirror().canvas_set_item_mirroring(canvas.id, item.id, mirroring->x, mirroring->y,
                                         current_frame());
    }
    if (resources().active()) {
      resources().canvas_set_item_mirroring(tap_context(), canvas.id, item.id, &mirroring->x);
    }
  }
  original<FnCanvasSetItemMirroring>(kCanvasSetItemMirroring)(self, canvas, item, mirroring);
}

void hook_canvas_set_item_repeat(void *self, RID item, const Point2 *repeat_size,
                                  int32_t repeat_times) {
  bump(kCanvasSetItemRepeat);
  if (repeat_size != nullptr) {
    CanvasItemRepeatKey key;
    zero(&key);
    key.item = item.id;
    key.repeat_size = *repeat_size;
    key.repeat_times = repeat_times;
    log_entry(&g_canvas_item_repeats, pod(key));
    if (streaming()) {
      mirror().canvas_set_item_repeat(item.id, repeat_size->x, repeat_size->y, repeat_times,
                                      current_frame());
    }
    if (resources().active()) {
      resources().canvas_set_item_repeat(tap_context(), item.id, &repeat_size->x, repeat_times);
    }
  }
  original<FnCanvasSetItemRepeat>(kCanvasSetItemRepeat)(self, item, repeat_size, repeat_times);
}

void hook_canvas_set_parent(void *self, RID canvas, RID parent, float scale) {
  bump(kCanvasSetParent);
  CanvasParentKey key;
  zero(&key);
  key.canvas = canvas.id;
  key.parent = parent.id;
  key.scale = scale;
  log_entry(&g_canvas_set_parents, pod(key));
  if (streaming()) {
    mirror().canvas_set_parent(canvas.id, parent.id, current_frame());
  }
  if (resources().active()) {
    resources().canvas_set_parent(tap_context(), canvas.id, parent.id);
  }
  original<FnCanvasSetParent>(kCanvasSetParent)(self, canvas, parent, scale);
}

// --- calibrator 3 hooks --------------------------------------------------------

void hook_viewport_attach_canvas(void *self, RID viewport, RID canvas) {
  bump(kViewportAttachCanvas);
  log_entry(&g_viewport_attaches, rids(viewport.id, canvas.id));
  if (streaming()) {
    mirror().viewport_attach_canvas(viewport.id, canvas.id, current_frame());
  }
  original<FnSetMaterial>(kViewportAttachCanvas)(self, viewport, canvas);
}

void hook_viewport_set_canvas_transform(void *self, RID viewport, RID canvas,
                                        const Transform2D *transform) {
  bump(kViewportSetCanvasTransform);
  if (transform != nullptr) {
    ViewportCanvasTransformKey key;
    zero(&key);
    key.viewport = viewport.id;
    key.canvas = canvas.id;
    key.transform = *transform;
    log_entry(&g_viewport_canvas_transforms, pod(key));
    if (streaming()) {
      mirror().viewport_set_canvas_transform(viewport.id, canvas.id, to_xform(*transform),
                                             current_frame());
    }
  }
  original<FnViewportSetCanvasTransform>(kViewportSetCanvasTransform)(self, viewport, canvas,
                                                                      transform);
}

RID hook_canvas_create(void *self) {
  bump(kCanvasCreate);
  const RID result = original<FnCreate>(kCanvasCreate)(self);
  log_entry(&g_canvas_creates, rids(result.id));
  if (streaming()) {
    mirror().canvas_create(result.id, current_frame());
  }
  return result;
}

void hook_set_parent(void *self, RID item, RID parent) {
  bump(kSetParent);
  log_entry(&g_set_parents, rids(item.id, parent.id));
  if (streaming()) {
    mirror().set_parent(item.id, parent.id, current_frame());
  }
  original<FnSetMaterial>(kSetParent)(self, item, parent);
}

void hook_set_visible(void *self, RID item, bool visible) {
  bump(kSetVisible);
  log_entry(&g_set_visibles, item_value(item, visible ? 1 : 0));
  if (streaming()) {
    mirror().set_visible(item.id, visible, current_frame());
  }
  original<FnRidBool>(kSetVisible)(self, item, visible);
}

void hook_set_clip(void *self, RID item, bool clip) {
  bump(kSetClip);
  log_entry(&g_set_clips, item_value(item, clip ? 1 : 0));
  if (streaming()) {
    mirror().set_clip(item.id, clip, current_frame());
  }
  original<FnRidBool>(kSetClip)(self, item, clip);
}

// --- CG1: the two back-buffer setters (render-stream-10.md "Capture") ------------------------
//
// Conditional: installed only under GRC_STREAM_VERSION=10 (hooks_plan), so every /2-/9 session,
// plan and counters.json is what it was. Each passes the call through first, then sets the item's
// mirror state as the engine does (renderer_canvas_cull.cpp:1871-1886, :2015-2033). A canvas group
// mode outside 0-3 cannot come from scene code (canvas_item.cpp:1690); it passes through, leaves
// the mirror unchanged and is counted in counters.json `captured.canvas_group_mode_invalid`.

std::atomic<uint64_t> g_canvas_group_mode_invalid{0};

void hook_set_canvas_group_mode(void *self, RID item, int32_t mode, float clear_margin,
                                bool fit_empty, float fit_margin, bool blur_mipmaps) {
  bump(kSetCanvasGroupMode);
  original<FnSetCanvasGroupMode>(kSetCanvasGroupMode)(self, item, mode, clear_margin, fit_empty,
                                                      fit_margin, blur_mipmaps);
  if (mode < 0 || mode > 3) {
    g_canvas_group_mode_invalid.fetch_add(1, std::memory_order_relaxed);
    return;
  }
  if (streaming()) {
    mirror().set_canvas_group_mode(item.id, mode, clear_margin, fit_empty, fit_margin,
                                   blur_mipmaps, current_frame());
  }
}

void hook_set_copy_to_backbuffer(void *self, RID item, bool enable, const Rect2 *rect) {
  bump(kSetCopyToBackbuffer);
  original<FnSetCustomRect>(kSetCopyToBackbuffer)(self, item, enable, rect);
  if (streaming()) {
    const rs2::Rect4 wire = rect != nullptr ? to_rect(*rect) : rs2::kZeroRect;
    mirror().set_copy_to_backbuffer(item.id, enable, wire, current_frame());
  }
}

void hook_set_custom_rect(void *self, RID item, bool enabled, const Rect2 *rect) {
  bump(kSetCustomRect);
  if (rect != nullptr) {
    ItemCustomRectKey key;
    zero(&key);
    key.item = item.id;
    key.enabled = enabled;
    key.rect = *rect;
    log_entry(&g_set_custom_rects, pod(key));
    if (streaming()) {
      mirror().set_custom_rect(item.id, enabled, to_rect(*rect), current_frame());
    }
  }
  original<FnSetCustomRect>(kSetCustomRect)(self, item, enabled, rect);
}

void hook_set_self_modulate(void *self, RID item, const Color *color) {
  bump(kSetSelfModulate);
  if (color != nullptr) {
    ItemColorKey key;
    zero(&key);
    key.item = item.id;
    key.color = *color;
    log_entry(&g_set_self_modulates, pod(key));
    if (streaming()) {
      mirror().set_self_modulate(item.id, to_color(*color), current_frame());
    }
  }
  original<FnSetModulate>(kSetSelfModulate)(self, item, color);
}

void hook_set_visibility_layer(void *self, RID item, uint32_t layer) {
  bump(kSetVisibilityLayer);
  log_entry(&g_set_visibility_layers, item_value(item, static_cast<int64_t>(layer)));
  if (streaming()) {
    mirror().set_visibility_layer(item.id, layer, current_frame());
  }
  original<FnRidU32>(kSetVisibilityLayer)(self, item, layer);
}

void hook_set_z_index(void *self, RID item, int z) {
  bump(kSetZIndex);
  log_entry(&g_set_z_indices, item_value(item, z));
  if (streaming()) {
    mirror().set_z_index(item.id, z, current_frame());
  }
  original<FnRidInt>(kSetZIndex)(self, item, z);
}

void hook_set_draw_index(void *self, RID item, int index) {
  bump(kSetDrawIndex);
  log_entry(&g_set_draw_indices, item_value(item, index));
  if (streaming()) {
    mirror().set_draw_index(item.id, index, current_frame());
  }
  original<FnRidInt>(kSetDrawIndex)(self, item, index);
}

void hook_set_z_as_relative(void *self, RID item, bool relative) {
  bump(kSetZAsRelative);
  log_entry(&g_set_z_as_relatives, item_value(item, relative ? 1 : 0));
  if (streaming()) {
    mirror().set_z_relative(item.id, relative, current_frame());
  }
  original<FnRidBool>(kSetZAsRelative)(self, item, relative);
}

void hook_set_draw_behind_parent(void *self, RID item, bool behind) {
  bump(kSetDrawBehindParent);
  log_entry(&g_set_draw_behinds, item_value(item, behind ? 1 : 0));
  if (streaming()) {
    mirror().set_behind(item.id, behind, current_frame());
  }
  original<FnRidBool>(kSetDrawBehindParent)(self, item, behind);
}

// --- calibrator 5 hooks (gate2-design.md Q2) -----------------------------------
//
// Counted, captured into counters.json and written to the texture hook log
// (G2a); since G2b2 (render-stream/2) the texture, filter and repeat hooks are
// mirror taps too, and canvas_item_add_lcd_texture_rect_region is an
// unsupported command (/2 declares it in observed_unsupported_ops). Since G2d
// the four canvas_texture_* hooks are mirror taps too (gate2-design.md Q3).

RID hook_texture_2d_placeholder_create(void *self) {
  bump(kTexture2dPlaceholderCreate);
  const RID result = original<FnCreate>(kTexture2dPlaceholderCreate)(self);
  log_entry(&g_placeholder_creates, rids(result.id));
  std::lock_guard<std::mutex> order(g_texture_order);
  const bool omit = omitted("texture_2d_placeholder_create");
  if (streaming() && !omit) {
    mirror().texture_2d_placeholder_create(result.id, current_frame());
  }
  resources().texture_2d_placeholder_create(tap_context(), result.id, omit);
  return result;
}

void hook_texture_replace(void *self, RID texture, RID by_texture) {
  bump(kTextureReplace);
  // G8r: either side may be a pre-arm texture; adopt it before the dummy frees the by-texture.
  rs::adopt_texture_ref(texture.id);
  rs::adopt_texture_ref(by_texture.id);
  log_entry(&g_texture_replaces, rids(texture.id, by_texture.id));
  original<FnSetMaterial>(kTextureReplace)(self, texture, by_texture);
  std::lock_guard<std::mutex> order(g_texture_order);
  const bool omit = omitted("texture_replace");
  if (streaming() && !omit) {
    mirror().texture_replace(texture.id, by_texture.id, current_frame());
  }
  resources().texture_replace(tap_context(), texture.id, by_texture.id, omit);
}

void hook_viewport_set_default_texture_filter(void *self, RID viewport, int32_t filter) {
  bump(kViewportSetDefaultTextureFilter);
  log_entry(&g_viewport_texture_filters, item_value(viewport, filter));
  if (streaming()) {
    mirror().viewport_set_texture_filter(viewport.id, filter, current_frame());
  }
  original<FnRidEnum>(kViewportSetDefaultTextureFilter)(self, viewport, filter);
  resources().viewport_set_default_texture_filter(tap_context(), viewport.id, filter);
}

void hook_viewport_set_default_texture_repeat(void *self, RID viewport, int32_t repeat) {
  bump(kViewportSetDefaultTextureRepeat);
  log_entry(&g_viewport_texture_repeats, item_value(viewport, repeat));
  if (streaming()) {
    mirror().viewport_set_texture_repeat(viewport.id, repeat, current_frame());
  }
  original<FnRidEnum>(kViewportSetDefaultTextureRepeat)(self, viewport, repeat);
  resources().viewport_set_default_texture_repeat(tap_context(), viewport.id, repeat);
}

RID hook_canvas_texture_create(void *self) {
  bump(kCanvasTextureCreate);
  RID result = original<FnCreate>(kCanvasTextureCreate)(self);
  // The opt-in headless shim (GRC_HEADLESS_CANVAS_TEXTURE=synthesize, rs_canvas_texture_shim.h):
  // the dummy storage's RID() becomes a private RID before anything -- log, mirror, engine --
  // sees it. Off, or a non-null engine result: unchanged.
  result.id = rs::canvas_texture_shim().on_create(result.id, current_frame());
  log_entry(&g_canvas_texture_creates, rids(result.id));
  std::lock_guard<std::mutex> order(g_texture_order);
  const bool omit = omitted("canvas_texture_create");
  if (streaming() && !omit) {
    mirror().canvas_texture_create(result.id, current_frame());
  }
  resources().canvas_texture_create(tap_context(), result.id, omit);
  return result;
}

void hook_canvas_texture_set_channel(void *self, RID canvas_texture, int32_t channel,
                                     RID texture) {
  bump(kCanvasTextureSetChannel);
  rs::adopt_texture_ref(texture.id);  // G8r
  ChannelKey key;
  zero(&key);
  key.canvas_texture = canvas_texture.id;
  key.channel = channel;
  key.texture = texture.id;
  log_entry(&g_canvas_texture_channels, pod(key));
  original<FnCanvasTextureSetChannel>(kCanvasTextureSetChannel)(self, canvas_texture, channel,
                                                                texture);
  std::lock_guard<std::mutex> order(g_texture_order);
  const bool omit = omitted("canvas_texture_set_channel");
  if (streaming() && !omit) {
    mirror().canvas_texture_set_channel(canvas_texture.id, channel, texture.id, current_frame());
  }
  resources().canvas_texture_set_channel(tap_context(), canvas_texture.id, channel, texture.id,
                                         omit);
}

void hook_canvas_texture_set_texture_filter(void *self, RID canvas_texture, int32_t filter) {
  bump(kCanvasTextureSetTextureFilter);
  log_entry(&g_canvas_texture_filters, item_value(canvas_texture, filter));
  original<FnRidEnum>(kCanvasTextureSetTextureFilter)(self, canvas_texture, filter);
  std::lock_guard<std::mutex> order(g_texture_order);
  const bool omit = omitted("canvas_texture_set_texture_filter");
  if (streaming() && !omit) {
    mirror().canvas_texture_set_filter(canvas_texture.id, filter, current_frame());
  }
  resources().canvas_texture_set_filter(tap_context(), canvas_texture.id, filter, omit);
}

void hook_canvas_texture_set_texture_repeat(void *self, RID canvas_texture, int32_t repeat) {
  bump(kCanvasTextureSetTextureRepeat);
  log_entry(&g_canvas_texture_repeats, item_value(canvas_texture, repeat));
  original<FnRidEnum>(kCanvasTextureSetTextureRepeat)(self, canvas_texture, repeat);
  std::lock_guard<std::mutex> order(g_texture_order);
  const bool omit = omitted("canvas_texture_set_texture_repeat");
  if (streaming() && !omit) {
    mirror().canvas_texture_set_repeat(canvas_texture.id, repeat, current_frame());
  }
  resources().canvas_texture_set_repeat(tap_context(), canvas_texture.id, repeat, omit);
}

void hook_set_default_texture_filter(void *self, RID item, int32_t filter) {
  bump(kSetDefaultTextureFilter);
  log_entry(&g_item_texture_filters, item_value(item, filter));
  if (streaming()) {
    mirror().set_texture_filter(item.id, filter, current_frame());
  }
  original<FnRidEnum>(kSetDefaultTextureFilter)(self, item, filter);
  resources().canvas_item_set_default_texture_filter(tap_context(), item.id, filter);
}

void hook_set_default_texture_repeat(void *self, RID item, int32_t repeat) {
  bump(kSetDefaultTextureRepeat);
  log_entry(&g_item_texture_repeats, item_value(item, repeat));
  if (streaming()) {
    mirror().set_texture_repeat(item.id, repeat, current_frame());
  }
  original<FnRidEnum>(kSetDefaultTextureRepeat)(self, item, repeat);
  resources().canvas_item_set_default_texture_repeat(tap_context(), item.id, repeat);
}

void hook_add_lcd_texture_rect_region(void *self, RID item, const Rect2 *rect, RID texture,
                                      const Rect2 *source, const Color *modulate) {
  bump(kAddLcdTextureRectRegion);
  tap_unsupported(item, "canvas_item_add_lcd_texture_rect_region");
  if (rect != nullptr && source != nullptr && modulate != nullptr) {
    LcdRectKey key;
    zero(&key);
    key.item = item.id;
    key.rect = *rect;
    key.texture = texture.id;
    key.source = *source;
    key.modulate = *modulate;
    log_entry(&g_lcd_rects, pod(key));
  }
  original<FnAddLcdTextureRectRegion>(kAddLcdTextureRectRegion)(self, item, rect, texture, source,
                                                                modulate);
}

// --- calibrator 6 hook (gate3-design.md Q2, D4) ------------------------------
//
// canvas_item_add_clip_ignore was an unsupported command (reason unsupported-op) until G5d; it is
// now the /4 add_clip_ignore command, replayed in order (gate5-design.md D10). The hook still logs
// it (item, ignore) into counters.json's captured, deduplicated like every other optional setter,
// so a calibration run can tell the two toggle directions apart.

void hook_add_clip_ignore(void *self, RID item, bool ignore) {
  bump(kAddClipIgnore);
  log_entry(&g_clip_ignores, item_value(item, ignore ? 1 : 0));
  if (streaming()) {
    mirror().add_clip_ignore(item.id, ignore, current_frame());
  }
  original<FnRidBool>(kAddClipIgnore)(self, item, ignore);
}

// --- hook table --------------------------------------------------------------

struct HookSpec {
  HookId id;
  const char *name;  // record slot key == RenderingServer method name
  void *hook;
};

template <typename F>
void *as_ptr(F *function) {
  return reinterpret_cast<void *>(function);
}

const HookSpec kSpecs[] = {
    {kAddRect, "canvas_item_add_rect", as_ptr(&hook_add_rect)},
    {kAddTextureRect, "canvas_item_add_texture_rect", as_ptr(&hook_add_texture_rect)},
    {kAddTextureRectRegion, "canvas_item_add_texture_rect_region",
     as_ptr(&hook_add_texture_rect_region)},
    {kAddMsdfTextureRectRegion, "canvas_item_add_msdf_texture_rect_region",
     as_ptr(&hook_add_msdf_texture_rect_region)},
    {kAddPolygon, "canvas_item_add_polygon", as_ptr(&hook_add_polygon)},
    {kTexture2dCreate, "texture_2d_create", as_ptr(&hook_texture_2d_create)},
    {kTexture2dUpdate, "texture_2d_update", as_ptr(&hook_texture_2d_update)},
    {kFree, "free", as_ptr(&hook_free)},
    {kAddTriangleArray, "canvas_item_add_triangle_array", as_ptr(&hook_add_triangle_array)},
    {kAddMesh, "canvas_item_add_mesh", as_ptr(&hook_add_mesh)},
    {kAddMultimesh, "canvas_item_add_multimesh", as_ptr(&hook_add_multimesh)},
    {kAddNinePatch, "canvas_item_add_nine_patch", as_ptr(&hook_add_nine_patch)},
    {kAddPrimitive, "canvas_item_add_primitive", as_ptr(&hook_add_primitive)},
    {kAddLine, "canvas_item_add_line", as_ptr(&hook_add_line)},
    {kAddPolyline, "canvas_item_add_polyline", as_ptr(&hook_add_polyline)},
    {kAddCircle, "canvas_item_add_circle", as_ptr(&hook_add_circle)},
    {kAddSetTransform, "canvas_item_add_set_transform", as_ptr(&hook_add_set_transform)},
    {kSetTransform, "canvas_item_set_transform", as_ptr(&hook_set_transform)},
    {kSetModulate, "canvas_item_set_modulate", as_ptr(&hook_set_modulate)},
    {kCanvasItemCreate, "canvas_item_create", as_ptr(&hook_canvas_item_create)},
    {kCanvasItemClear, "canvas_item_clear", as_ptr(&hook_canvas_item_clear)},
    {kSetMaterial, "canvas_item_set_material", as_ptr(&hook_set_material)},
    {kMeshCreate, "mesh_create", as_ptr(&hook_mesh_create)},
    {kMeshAddSurface, "mesh_add_surface", as_ptr(&hook_mesh_add_surface)},
    {kMeshUpdateVertexRegion, "mesh_surface_update_vertex_region",
     as_ptr(&hook_mesh_update_vertex_region)},
    {kMeshUpdateAttributeRegion, "mesh_surface_update_attribute_region",
     as_ptr(&hook_mesh_update_attribute_region)},
    {kMeshClear, "mesh_clear", as_ptr(&hook_mesh_clear)},
    {kMeshSetCustomAabb, "mesh_set_custom_aabb", as_ptr(&hook_mesh_set_custom_aabb)},
    {kShaderCreateFromCode, "shader_create_from_code", as_ptr(&hook_shader_create_from_code)},
    {kShaderSetCode, "shader_set_code", as_ptr(&hook_shader_set_code)},
    {kMaterialSetParam, "material_set_param", as_ptr(&hook_material_set_param)},
    {kViewportAttachCanvas, "viewport_attach_canvas", as_ptr(&hook_viewport_attach_canvas)},
    {kViewportSetCanvasTransform, "viewport_set_canvas_transform",
     as_ptr(&hook_viewport_set_canvas_transform)},
    {kCanvasCreate, "canvas_create", as_ptr(&hook_canvas_create)},
    {kSetParent, "canvas_item_set_parent", as_ptr(&hook_set_parent)},
    {kSetVisible, "canvas_item_set_visible", as_ptr(&hook_set_visible)},
    {kSetClip, "canvas_item_set_clip", as_ptr(&hook_set_clip)},
    {kSetCustomRect, "canvas_item_set_custom_rect", as_ptr(&hook_set_custom_rect)},
    {kSetSelfModulate, "canvas_item_set_self_modulate", as_ptr(&hook_set_self_modulate)},
    {kSetVisibilityLayer, "canvas_item_set_visibility_layer",
     as_ptr(&hook_set_visibility_layer)},
    {kSetZIndex, "canvas_item_set_z_index", as_ptr(&hook_set_z_index)},
    {kSetDrawIndex, "canvas_item_set_draw_index", as_ptr(&hook_set_draw_index)},
    {kSetZAsRelative, "canvas_item_set_z_as_relative_to_parent", as_ptr(&hook_set_z_as_relative)},
    {kSetDrawBehindParent, "canvas_item_set_draw_behind_parent",
     as_ptr(&hook_set_draw_behind_parent)},
    {kTexture2dPlaceholderCreate, "texture_2d_placeholder_create",
     as_ptr(&hook_texture_2d_placeholder_create)},
    {kTextureReplace, "texture_replace", as_ptr(&hook_texture_replace)},
    {kViewportSetDefaultTextureFilter, "viewport_set_default_canvas_item_texture_filter",
     as_ptr(&hook_viewport_set_default_texture_filter)},
    {kViewportSetDefaultTextureRepeat, "viewport_set_default_canvas_item_texture_repeat",
     as_ptr(&hook_viewport_set_default_texture_repeat)},
    {kCanvasTextureCreate, "canvas_texture_create", as_ptr(&hook_canvas_texture_create)},
    {kCanvasTextureSetChannel, "canvas_texture_set_channel",
     as_ptr(&hook_canvas_texture_set_channel)},
    {kCanvasTextureSetTextureFilter, "canvas_texture_set_texture_filter",
     as_ptr(&hook_canvas_texture_set_texture_filter)},
    {kCanvasTextureSetTextureRepeat, "canvas_texture_set_texture_repeat",
     as_ptr(&hook_canvas_texture_set_texture_repeat)},
    {kSetDefaultTextureFilter, "canvas_item_set_default_texture_filter",
     as_ptr(&hook_set_default_texture_filter)},
    {kSetDefaultTextureRepeat, "canvas_item_set_default_texture_repeat",
     as_ptr(&hook_set_default_texture_repeat)},
    {kAddLcdTextureRectRegion, "canvas_item_add_lcd_texture_rect_region",
     as_ptr(&hook_add_lcd_texture_rect_region)},
    {kAddClipIgnore, "canvas_item_add_clip_ignore", as_ptr(&hook_add_clip_ignore)},
    {kMeshCreateFromSurfaces, "mesh_create_from_surfaces", as_ptr(&hook_mesh_create_from_surfaces)},
    {kMeshUpdateSkinRegion, "mesh_surface_update_skin_region", as_ptr(&hook_mesh_update_skin_region)},
    {kMeshUpdateIndexRegion, "mesh_surface_update_index_region",
     as_ptr(&hook_mesh_update_index_region)},
    {kMeshSurfaceRemove, "mesh_surface_remove", as_ptr(&hook_mesh_surface_remove)},
    {kAddMultiline, "canvas_item_add_multiline", as_ptr(&hook_add_multiline)},
    {kAddParticles, "canvas_item_add_particles", as_ptr(&hook_add_particles)},
    {kAddAnimationSlice, "canvas_item_add_animation_slice", as_ptr(&hook_add_animation_slice)},
    {kAttachSkeleton, "canvas_item_attach_skeleton", as_ptr(&hook_attach_skeleton)},
    {kShaderCreate, "shader_create", as_ptr(&hook_shader_create)},
    {kShaderSetDefaultTextureParameter, "shader_set_default_texture_parameter",
     as_ptr(&hook_shader_set_default_texture_parameter)},
    {kMaterialCreate, "material_create", as_ptr(&hook_material_create)},
    {kMaterialCreateFromShader, "material_create_from_shader",
     as_ptr(&hook_material_create_from_shader)},
    {kMaterialSetShader, "material_set_shader", as_ptr(&hook_material_set_shader)},
    {kSetCanvasModulate, "canvas_set_modulate", as_ptr(&hook_set_canvas_modulate)},
    {kSetUseParentMaterial, "canvas_item_set_use_parent_material",
     as_ptr(&hook_set_use_parent_material)},
    {kSetInstanceShaderParameter, "canvas_item_set_instance_shader_parameter",
     as_ptr(&hook_set_instance_shader_parameter)},
    {kCanvasLightAttachToCanvas, "canvas_light_attach_to_canvas",
     as_ptr(&hook_canvas_light_attach_to_canvas)},
    {kViewportRemoveCanvas, "viewport_remove_canvas", as_ptr(&hook_viewport_remove_canvas)},
    {kViewportSetGlobalCanvasTransform, "viewport_set_global_canvas_transform",
     as_ptr(&hook_viewport_set_global_canvas_transform)},
    {kViewportSetCanvasStacking, "viewport_set_canvas_stacking",
     as_ptr(&hook_viewport_set_canvas_stacking)},
    {kCanvasSetItemMirroring, "canvas_set_item_mirroring",
     as_ptr(&hook_canvas_set_item_mirroring)},
    {kCanvasSetItemRepeat, "canvas_set_item_repeat", as_ptr(&hook_canvas_set_item_repeat)},
    {kCanvasSetParent, "canvas_set_parent", as_ptr(&hook_canvas_set_parent)},
    {kTextureSetPath, "texture_set_path", as_ptr(&hook_texture_set_path)},
    {kSetCopyToBackbuffer, "canvas_item_set_copy_to_backbuffer",
     as_ptr(&hook_set_copy_to_backbuffer)},
    {kSetCanvasGroupMode, "canvas_item_set_canvas_group_mode",
     as_ptr(&hook_set_canvas_group_mode)},
};
static_assert(sizeof(kSpecs) / sizeof(kSpecs[0]) == kHookCount, "one spec per hook id");

// --- JSON --------------------------------------------------------------------

void write_vector2_array(JsonWriter *json, const std::vector<Point2> &points, bool bits) {
  json->array_begin();
  for (const Point2 &point : points) {
    json->array_begin();
    if (bits) {
      json->float32_bits(point.x).float32_bits(point.y);
    } else {
      json->float32(point.x).float32(point.y);
    }
    json->array_end();
  }
  json->array_end();
}

void write_color_array(JsonWriter *json, const std::vector<Color> &colors, bool bits) {
  json->array_begin();
  for (const Color &color : colors) {
    json->array_begin();
    if (bits) {
      json->float32_bits(color.r)
          .float32_bits(color.g)
          .float32_bits(color.b)
          .float32_bits(color.a);
    } else {
      json->float32(color.r).float32(color.g).float32(color.b).float32(color.a);
    }
    json->array_end();
  }
  json->array_end();
}

void write_image_captures(JsonWriter *json, const std::vector<ImageCapture> &captures,
                          bool with_layer) {
  json->array_begin();
  for (const ImageCapture &capture : captures) {
    json->object_begin();
    json->field("rid", std::to_string(capture.rid));
    json->field("frame", static_cast<int64_t>(capture.frame));
    if (with_layer) {
      json->field("layer", capture.layer);
    }
    json->field("width", capture.width);
    json->field("height", capture.height);
    json->field("format", capture.format);
    json->field("data_size", capture.data_size);
    json->field("details", capture.details);
    json->object_end();
  }
  json->array_end();
}

// "name": [floats...] and "name_bits": ["0x........", ...].
void write_floats(JsonWriter *json, const std::string &name, const float *values, size_t count) {
  json->key(name).array_begin();
  for (size_t i = 0; i < count; ++i) {
    json->float32(values[i]);
  }
  json->array_end();
  json->key(name + "_bits").array_begin();
  for (size_t i = 0; i < count; ++i) {
    json->float32_bits(values[i]);
  }
  json->array_end();
}

template <typename T>
void write_floats(JsonWriter *json, const std::string &name, const T &value) {
  static_assert(sizeof(T) % sizeof(float) == 0, "a float aggregate");
  float values[sizeof(T) / sizeof(float)];
  std::memcpy(values, &value, sizeof(T));
  write_floats(json, name, values, sizeof(T) / sizeof(float));
}

void write_rid(JsonWriter *json, const std::string &name, uint64_t rid) {
  json->field(name, std::to_string(rid));
}

void write_seen(JsonWriter *json, const Seen &seen) {
  json->field("calls", static_cast<int64_t>(seen.calls));
  json->field("first_frame", static_cast<int64_t>(seen.first_frame));
  json->field("last_frame", static_cast<int64_t>(seen.last_frame));
}

std::string hex_bytes(const uint8_t *data, size_t size) {
  static const char kDigits[] = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (size_t i = 0; i < size; ++i) {
    out.push_back(kDigits[data[i] >> 4]);
    out.push_back(kDigits[data[i] & 0xf]);
  }
  return out;
}

enum class GeometryKind { kTriangleArray, kPrimitive, kPolyline, kMultiline };

void write_geometry(JsonWriter *json, const GeometryEntry &e, GeometryKind kind) {
  json->object_begin();
  write_rid(json, "item", e.item);
  if (kind == GeometryKind::kTriangleArray) {
    json->key("indices").array_begin();
    for (int32_t index : e.indices) {
      json->integer(index);
    }
    json->array_end();
    json->field("indices_total", e.indices_total);
  }
  json->key("points");
  write_vector2_array(json, e.points, false);
  json->key("point_bits");
  write_vector2_array(json, e.points, true);
  json->field("points_total", e.points_total);
  json->key("colors");
  write_color_array(json, e.colors, false);
  json->key("color_bits");
  write_color_array(json, e.colors, true);
  json->field("colors_total", e.colors_total);
  if (kind != GeometryKind::kPolyline && kind != GeometryKind::kMultiline) {
    json->key("uvs");
    write_vector2_array(json, e.uvs, false);
    json->key("uv_bits");
    write_vector2_array(json, e.uvs, true);
    json->field("uvs_total", e.uvs_total);
    write_rid(json, "texture", e.texture);
  }
  if (kind == GeometryKind::kTriangleArray) {
    json->field("bones_total", e.bones_total);
    json->field("weights_total", e.weights_total);
    json->field("count", e.count);
  }
  if (kind == GeometryKind::kPolyline || kind == GeometryKind::kMultiline) {
    write_floats(json, "width", &e.width, 1);
    json->field("antialiased", e.antialiased);
  }
  write_seen(json, e.seen);
  json->object_end();
}

template <typename Entry, typename Writer>
void write_log(JsonWriter *json, const char *name, const Log<Entry> &log, Writer writer) {
  json->key(name).array_begin();
  for (const Entry &entry : log.entries) {
    json->object_begin();
    writer(json, entry);
    write_seen(json, entry.seen);
    json->object_end();
  }
  json->array_end();
}

void write_aabb(JsonWriter *json, const AABB &aabb) { write_floats(json, "aabb", aabb); }

void write_region(JsonWriter *json, const PodEntry<RegionKey> &entry) {
  const RegionKey &k = entry.key;
  write_rid(json, "mesh", k.mesh);
  json->field("surface", static_cast<int64_t>(k.surface));
  json->field("offset", static_cast<int64_t>(k.offset));
  json->field("data_size", k.data_size);
  json->field("head_hex", hex_bytes(k.head, k.head_size));
}

// Copies every log under the mutex so serialising never races a hook.
struct Snapshot {
  std::vector<RectCapture> rects;
  std::vector<PolygonCapture> polygons;
  std::vector<ImageCapture> creates;
  std::vector<ImageCapture> updates;
  Log<GeometryEntry> triangle_arrays, primitives, polylines;
  Log<PodEntry<NinePatchKey>> nine_patches;
  Log<PodEntry<LineKey>> lines;
  Log<PodEntry<CircleKey>> circles;
  Log<PodEntry<ItemTransformKey>> add_set_transforms, set_transforms;
  Log<PodEntry<ItemColorKey>> set_modulates;
  Log<PodEntry<AddMeshKey>> add_meshes;
  Log<PodEntry<RidTripleKey>> add_multimeshes, canvas_item_creates, canvas_item_clears,
      set_materials, mesh_creates, mesh_clears, shader_creates, shader_codes, material_params;
  Log<PodEntry<MeshSurfaceKey>> mesh_surfaces;
  Log<PodEntry<RegionKey>> vertex_regions, attribute_regions;
  Log<PodEntry<MeshAabbKey>> mesh_aabbs;
  Log<PodEntry<RidTripleKey>> frees, viewport_attaches, canvas_creates, set_parents;
  Log<PodEntry<ViewportCanvasTransformKey>> viewport_canvas_transforms;
  Log<PodEntry<ItemValueKey>> set_visibles, set_clips, set_visibility_layers, set_z_indices,
      set_draw_indices, set_z_as_relatives, set_draw_behinds;
  // calibrator 5
  Log<PodEntry<TextureRectKey>> texture_rects;
  Log<PodEntry<TextureRectRegionKey>> texture_rect_regions;
  Log<PodEntry<RidTripleKey>> placeholder_creates, texture_replaces, canvas_texture_creates;
  Log<PodEntry<ItemValueKey>> viewport_texture_filters, viewport_texture_repeats,
      canvas_texture_filters, canvas_texture_repeats, item_texture_filters, item_texture_repeats;
  Log<PodEntry<ChannelKey>> canvas_texture_channels;
  Log<PodEntry<MsdfRectKey>> msdf_rects;
  Log<PodEntry<LcdRectKey>> lcd_rects;
  Log<PodEntry<ItemCustomRectKey>> set_custom_rects;
  Log<PodEntry<ItemColorKey>> set_self_modulates;
  // calibrator 6
  Log<PodEntry<ItemValueKey>> clip_ignores;
  // calibrator 7
  Log<PodEntry<RidTripleKey>> mesh_create_from_surfaces_calls;
  Log<PodEntry<RegionKey>> skin_regions, index_regions;
  Log<PodEntry<ItemValueKey>> mesh_surface_removes;
  Log<GeometryEntry> multilines;
  Log<PodEntry<RidTripleKey>> add_particles;
  Log<PodEntry<AnimationSliceKey>> animation_slices;
  Log<PodEntry<RidTripleKey>> attach_skeletons;
  // calibrator 8
  Log<PodEntry<RidTripleKey>> shader_create_calls, material_create_calls, material_set_shaders,
      set_instance_shader_parameters, canvas_light_attaches;
  Log<PodEntry<ShaderDefaultTextureKey>> shader_default_textures;
  Log<PodEntry<MaterialShaderKey>> material_create_from_shader_calls;
  Log<PodEntry<ItemColorKey>> canvas_set_modulates;
  Log<PodEntry<ItemValueKey>> set_use_parent_materials;
  // calibrator 9
  Log<PodEntry<RidTripleKey>> viewport_remove_canvases;
  Log<PodEntry<ViewportTransformKey>> viewport_global_canvas_transforms;
  Log<PodEntry<CanvasStackingKey>> canvas_stackings;
  Log<PodEntry<CanvasItemMirroringKey>> canvas_item_mirrorings;
  Log<PodEntry<CanvasItemRepeatKey>> canvas_item_repeats;
  Log<PodEntry<CanvasParentKey>> canvas_set_parents;
};

Snapshot take_snapshot() {
  Snapshot s;
  std::lock_guard<std::mutex> lock(g_mutex);
  s.rects = g_rects;
  s.polygons = g_polygons;
  s.creates = g_creates;
  s.updates = g_updates;
  s.triangle_arrays = g_triangle_arrays;
  s.primitives = g_primitives;
  s.polylines = g_polylines;
  s.nine_patches = g_nine_patches;
  s.lines = g_lines;
  s.circles = g_circles;
  s.add_set_transforms = g_add_set_transforms;
  s.set_transforms = g_set_transforms;
  s.set_modulates = g_set_modulates;
  s.add_meshes = g_add_meshes;
  s.add_multimeshes = g_add_multimeshes;
  s.canvas_item_creates = g_canvas_item_creates;
  s.canvas_item_clears = g_canvas_item_clears;
  s.set_materials = g_set_materials;
  s.mesh_creates = g_mesh_creates;
  s.mesh_surfaces = g_mesh_surfaces;
  s.vertex_regions = g_vertex_regions;
  s.attribute_regions = g_attribute_regions;
  s.mesh_clears = g_mesh_clears;
  s.mesh_aabbs = g_mesh_aabbs;
  s.shader_creates = g_shader_creates;
  s.shader_codes = g_shader_codes;
  s.material_params = g_material_params;
  s.frees = g_frees;
  s.viewport_attaches = g_viewport_attaches;
  s.viewport_canvas_transforms = g_viewport_canvas_transforms;
  s.canvas_creates = g_canvas_creates;
  s.set_parents = g_set_parents;
  s.set_visibles = g_set_visibles;
  s.set_clips = g_set_clips;
  s.set_custom_rects = g_set_custom_rects;
  s.set_self_modulates = g_set_self_modulates;
  s.set_visibility_layers = g_set_visibility_layers;
  s.set_z_indices = g_set_z_indices;
  s.set_draw_indices = g_set_draw_indices;
  s.set_z_as_relatives = g_set_z_as_relatives;
  s.set_draw_behinds = g_set_draw_behinds;
  s.texture_rects = g_texture_rects;
  s.texture_rect_regions = g_texture_rect_regions;
  s.placeholder_creates = g_placeholder_creates;
  s.texture_replaces = g_texture_replaces;
  s.canvas_texture_creates = g_canvas_texture_creates;
  s.viewport_texture_filters = g_viewport_texture_filters;
  s.viewport_texture_repeats = g_viewport_texture_repeats;
  s.canvas_texture_filters = g_canvas_texture_filters;
  s.canvas_texture_repeats = g_canvas_texture_repeats;
  s.item_texture_filters = g_item_texture_filters;
  s.item_texture_repeats = g_item_texture_repeats;
  s.canvas_texture_channels = g_canvas_texture_channels;
  s.msdf_rects = g_msdf_rects;
  s.lcd_rects = g_lcd_rects;
  s.clip_ignores = g_clip_ignores;
  s.mesh_create_from_surfaces_calls = g_mesh_create_from_surfaces_calls;
  s.skin_regions = g_skin_regions;
  s.index_regions = g_index_regions;
  s.mesh_surface_removes = g_mesh_surface_removes;
  s.multilines = g_multilines;
  s.add_particles = g_add_particles;
  s.animation_slices = g_animation_slices;
  s.attach_skeletons = g_attach_skeletons;
  s.shader_create_calls = g_shader_create_calls;
  s.shader_default_textures = g_shader_default_textures;
  s.material_create_calls = g_material_create_calls;
  s.material_create_from_shader_calls = g_material_create_from_shader_calls;
  s.material_set_shaders = g_material_set_shaders;
  s.canvas_set_modulates = g_canvas_set_modulates;
  s.set_use_parent_materials = g_set_use_parent_materials;
  s.set_instance_shader_parameters = g_set_instance_shader_parameters;
  s.canvas_light_attaches = g_canvas_light_attaches;
  s.viewport_remove_canvases = g_viewport_remove_canvases;
  s.viewport_global_canvas_transforms = g_viewport_global_canvas_transforms;
  s.canvas_stackings = g_canvas_stackings;
  s.canvas_item_mirrorings = g_canvas_item_mirrorings;
  s.canvas_item_repeats = g_canvas_item_repeats;
  s.canvas_set_parents = g_canvas_set_parents;
  return s;
}

}  // namespace

void hooks_init_image_binds() {
  if (g_image_binds.resolved) {
    return;
  }
  g_image_binds.resolved = true;
  // Hashes from `extension_api.json` of Godot 4.5.1 (Image is a stable API).
  g_image_binds.get_width = method_bind("Image", "get_width", 3905245786LL);
  g_image_binds.get_height = method_bind("Image", "get_height", 3905245786LL);
  g_image_binds.get_format = method_bind("Image", "get_format", 3847873762LL);
  g_image_binds.get_data_size = method_bind("Image", "get_data_size", 3905245786LL);
  g_image_binds.available = g_image_binds.get_width != nullptr &&
                            g_image_binds.get_height != nullptr &&
                            g_image_binds.get_format != nullptr &&
                            g_image_binds.get_data_size != nullptr;
  // Gate 2 (G2a): has_mipmaps (hash from the same dump) and the image_ptr
  // interface function complete what a payload copy needs.
  g_image_binds.has_mipmaps = method_bind("Image", "has_mipmaps", 36873697LL);
  // G8kw: optional; without it a texture worker is never used (the copy stays synchronous).
  g_image_binds.duplicate = method_bind("Resource", "duplicate", 482882304LL);
  g_image_binds.payload_available = g_image_binds.available &&
                                    g_image_binds.has_mipmaps != nullptr &&
                                    g_iface.image_ptr != nullptr;
}

bool hooks_image_details_available() { return g_image_binds.available; }

bool hooks_image_payload_available() { return g_image_binds.payload_available; }

void hooks_set_main_thread() { g_main_thread = std::this_thread::get_id(); }

void hooks_set_resource_policy(const rs::FormatPolicy &formats, uint64_t max_payload_bytes) {
  g_resource_policy.formats = formats;
  g_resource_policy.max_payload_bytes = max_payload_bytes;
}

void hooks_set_texture_workers(const rs::TextureWorkerConfig &config) {
  g_texture_worker_min_bytes.store(config.min_bytes, std::memory_order_release);
  g_texture_workers.store(config.workers, std::memory_order_release);
}

void hooks_set_frame(uint64_t frame) { g_frame.store(frame, std::memory_order_relaxed); }

bool hooks_adopt_texture(uint64_t rid, void *image_object, rs2::AdoptedContent content,
                         const char *source, bool *decoded) {
  if (decoded != nullptr) {
    *decoded = false;
  }
  if (rid == 0 || image_object == nullptr || !streaming() || !resources().active()) {
    return false;
  }
  const uint64_t t_hook = now_ns();
  Ref image{image_object};
  const ImageFacts facts = read_image(&image);
  rs::PayloadPtr bytes;
  rs::TextureJobPtr job;
  rs::PayloadCopy copy = copy_payload(facts, &image, &bytes, &job);
  if (job != nullptr) {
    copy.hook_ns = static_cast<int64_t>(now_ns() - t_hook);
  }
  std::lock_guard<std::mutex> order(g_texture_order);
  if (mirror().knows_texture(rid)) {
    return false;  // a loader thread created or adopted it meanwhile
  }
  mirror().texture_adopt(rid, copy, std::move(bytes), content, current_frame(), job);
  resources().texture_adopt(tap_context(), rid, copy,
                            content == rs2::AdoptedContent::Current ? "current" : "creation",
                            source, job);
  if (decoded != nullptr) {
    *decoded = copy.status == "ok" && copy.source_format >= 0;
  }
  return true;
}

bool hooks_adopt_mesh(uint64_t rid, const std::vector<rs::AdoptSurface> &surfaces,
                      const float custom_aabb[6]) {
  if (rid == 0 || !streaming() || !resources().active()) {
    return false;
  }
  std::vector<MeshSurfaceBuffer> buffers;
  std::vector<rs::MeshSurfaceInput> inputs;
  std::vector<rs::MeshSurfaceCopy> copies;
  for (const rs::AdoptSurface &a : surfaces) {
    SurfaceView v;
    v.primitive = a.primitive;
    v.format = a.format;
    v.vertex_count = a.vertex_count;
    v.index_count = a.index_count;
    v.aabb = AABB{{a.aabb[0], a.aabb[1], a.aabb[2]}, {a.aabb[3], a.aabb[4], a.aabb[5]}};
    v.uv_scale = Vector4{a.uv_scale[0], a.uv_scale[1], a.uv_scale[2], a.uv_scale[3]};
    v.vertex = a.vertex;
    v.vertex_bytes = a.vertex_bytes;
    v.attribute = a.attribute;
    v.attribute_bytes = a.attribute_bytes;
    v.skin = a.skin;
    v.skin_bytes = a.skin_bytes;
    v.index = a.index;
    v.index_bytes = a.index_bytes;
    v.blend_shape_bytes = a.blend_shape_bytes;
    MeshSurfaceBuffer buffer;
    rs::MeshSurfaceInput input;
    input.copy = copy_mesh_surface(v, &buffer, &input.bytes);
    copies.push_back(input.copy);
    inputs.push_back(std::move(input));
    buffers.push_back(std::move(buffer));
  }
  std::array<float, 6> aabb = {custom_aabb[0], custom_aabb[1], custom_aabb[2],
                               custom_aabb[3], custom_aabb[4], custom_aabb[5]};
  std::lock_guard<std::mutex> order(g_texture_order);
  if (mirror().knows_mesh(rid)) {
    return false;
  }
  std::lock_guard<std::mutex> lock(g_mutex);
  g_mesh_buffers[rid] = std::move(buffers);
  mirror().mesh_adopt(rid, inputs, aabb, current_frame());
  resources().mesh_adopt(tap_context(), rid, copies);
  return true;
}

// --- G8m (gate8-design.md D11, D12, Q5; rs_adopt.h): pre-arm shaders and materials ---------

void hooks_internal_begin(std::string *code_out, uint64_t *rid_out) {
  t_internal = true;
  t_internal_code = code_out;
  t_internal_rid = rid_out;
}

void hooks_internal_end() {
  t_internal = false;
  t_internal_code = nullptr;
  t_internal_rid = nullptr;
}

bool hooks_adopt_shader(uint64_t rid, const std::string &code) {
  if (rid == 0 || !streaming() || !resources().active()) {
    return false;
  }
  rs::ShaderCodeInput input;
  input.copy = copy_shader_code_text(code, now_ns(), &input.bytes);
  std::lock_guard<std::mutex> order(g_texture_order);
  if (mirror().knows_shader(rid)) {
    return false;
  }
  mirror().shader_adopt(rid, input, current_frame());
  resources().shader_create_from_code(tap_context(), rid, input.copy, false);
  return true;
}

bool hooks_adopt_shader_refused(uint64_t rid, rs2::ShaderReason reason) {
  if (rid == 0 || !streaming() || !resources().active()) {
    return false;
  }
  std::lock_guard<std::mutex> order(g_texture_order);
  if (mirror().knows_shader(rid)) {
    return false;
  }
  mirror().shader_adopt_refused(rid, reason, current_frame());
  resources().shader_create(tap_context(), rid, false);
  return true;
}

void hooks_adopt_default_texture(uint64_t shader, const std::string &name, uint64_t texture,
                                 int32_t index) {
  if (shader == 0 || !streaming() || !resources().active()) {
    return;
  }
  rs::adopt_texture_ref(texture);
  std::lock_guard<std::mutex> order(g_texture_order);
  mirror().shader_set_default_texture_parameter(shader, name, texture, index, current_frame());
  resources().shader_set_default_texture_parameter(tap_context(), shader, name, texture, index,
                                                    false);
}

bool hooks_adopt_material(uint64_t material, uint64_t shader,
                          const std::vector<rs::AdoptParam> &params) {
  if (material == 0 || !streaming() || !resources().active()) {
    return false;
  }
  std::vector<std::pair<rs::DecodedParam, rs::MaterialParamCopy>> decoded(params.size());
  for (std::size_t i = 0; i < params.size(); ++i) {
    decoded[i].second = decode_material_param(params[i].variant, &decoded[i].first);
    if (decoded[i].first.type == "rid" && decoded[i].first.status == "ok") {
      rs::adopt_texture_ref(decoded[i].first.tex_rid);
    }
  }
  std::lock_guard<std::mutex> order(g_texture_order);
  if (mirror().knows_material(material)) {
    return false;
  }
  const uint64_t frame = current_frame();
  mirror().material_adopt(material, frame);
  resources().material_create(tap_context(), material, false);
  if (shader != 0) {
    mirror().material_set_shader(material, shader, frame);
    resources().material_set_shader(tap_context(), material, shader, false);
  }
  for (std::size_t i = 0; i < params.size(); ++i) {
    mirror().material_set_param(material, params[i].name, decoded[i].first, frame);
    resources().material_set_param(tap_context(), material, params[i].name, decoded[i].second,
                                   false);
  }
  return true;
}

void hooks_adopt_item_material(uint64_t item, uint64_t material) {
  if (!streaming()) {
    return;
  }
  mirror().set_material(item, material, current_frame());
  if (resources().active()) {
    resources().canvas_item_set_material(tap_context(), item, material);
  }
}

void hooks_adopt_material_shader(uint64_t material, uint64_t shader) {
  if (!streaming() || !resources().active()) {
    return;
  }
  std::lock_guard<std::mutex> order(g_texture_order);
  mirror().material_set_shader(material, shader, current_frame());
  resources().material_set_shader(tap_context(), material, shader, false);
}

void hooks_adopt_instance_param(uint64_t item, const std::string &name, const void *variant) {
  if (!streaming()) {
    return;
  }
  rs::DecodedParam decoded;
  const rs::MaterialParamCopy copy = decode_material_param(variant, &decoded);
  if (decoded.type == "rid" && decoded.status == "ok") {
    rs::adopt_texture_ref(decoded.tex_rid);
  }
  mirror().set_instance_shader_parameter(item, name, decoded, current_frame());
  if (resources().active()) {
    resources().canvas_item_set_instance_shader_parameter(tap_context(), item, name, copy);
  }
}

bool hooks_plan(const Calibration &calib, HookPlan *plan) {
  *plan = HookPlan();
  g_planned_names.clear();
  g_omitted_names.clear();
  const char *cache_dir = std::getenv("GRC_TEXTURE_CACHE_DIR");
  const bool path_hook_wanted = cache_dir != nullptr && cache_dir[0] != '\0';
  // CG1: the back-buffer hooks exist for /10's item keys only (GRC_STREAM_VERSION=10).
  const char *stream_version = std::getenv("GRC_STREAM_VERSION");
  const bool backbuffer_hooks_wanted =
      stream_version != nullptr && std::strcmp(stream_version, "10") == 0;
  g_canvas_group_mode_invalid.store(0);
  g_hooks_total = kHookCount;
  for (const HookSpec &spec : kSpecs) {
    const int64_t index = calib.slot(spec.name);
    const bool required = spec.id < kRequiredHookCount;
    g_omitted[spec.id] = false;
    g_skipped[spec.id] = false;
    if (spec.id == kTextureSetPath && !path_hook_wanted) {
      // G8kc: conditional hook. Without a cache directory the plan, counters and session are
      // exactly what they were before the hook existed.
      g_skipped[spec.id] = true;
      --g_hooks_total;
      continue;
    }
    if ((spec.id == kSetCopyToBackbuffer || spec.id == kSetCanvasGroupMode) &&
        !backbuffer_hooks_wanted) {
      // CG1 (render-stream-10.md "Capture"): conditional like texture_set_path; neither planned
      // nor omitted below /10.
      g_skipped[spec.id] = true;
      --g_hooks_total;
      continue;
    }
    if (index < 0) {
      if (required) {
        if (plan->missing_required.empty()) {
          plan->missing_required = spec.name;
        }
      } else {
        g_omitted[spec.id] = true;
        plan->omitted.push_back(spec.name);
      }
      continue;
    }
    SlotReplacement replacement;
    replacement.index = static_cast<size_t>(index);
    replacement.hook = spec.hook;
    replacement.original_out = &g_original[spec.id];
    plan->replacements.push_back(replacement);
    plan->planned.push_back(spec.name);
  }
  g_planned_names = plan->planned;
  g_omitted_names = plan->omitted;
  return plan->missing_required.empty();
}

void hooks_reset_texture_cache_notes() {
  std::lock_guard<std::mutex> lock(g_cache_mutex);
  g_cache_notes.clear();
  g_texture_paths.clear();
  g_set_path_calls.clear();
  g_cache_pending.clear();
}

std::string hooks_texture_cache_json() {
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-texture-cache/1"));
  json.field("path_hook", !g_skipped[kTextureSetPath] && !g_omitted[kTextureSetPath]);
  json.key("textures").array_begin();
  {
    std::lock_guard<std::mutex> lock(g_cache_mutex);
    for (auto &kv : g_cache_notes) {
      resolve_note(&kv.second);
      const rs::PayloadCopy &copy = kv.second.copy;
      const std::string outcome = kv.second.job != nullptr ? std::string("pending") : copy.cache_outcome;
      json.object_begin();
      json.field("id", std::to_string(kv.first));
      const auto path = g_texture_paths.find(kv.first);
      if (path != g_texture_paths.end()) {
        json.field("path", path->second);
      } else {
        json.field_null("path");
      }
      if (copy.source_key.empty()) {
        json.field_null("source_key");
      } else {
        json.field("source_key", copy.source_key);
      }
      json.field("outcome", outcome);
      json.field("status", copy.status);
      json.field("hash", copy.hash);
      json.object_end();
    }
  }
  json.array_end();
  json.object_end();
  return json.take();
}

std::string hooks_plan_detail(const HookPlan &plan) {
  std::string detail = std::to_string(plan.planned.size()) + " of " +
                       std::to_string(static_cast<size_t>(g_hooks_total)) + " hooks named by the record";
  if (!plan.missing_required.empty()) {
    detail += "; required hook missing: " + plan.missing_required;
  }
  if (!plan.omitted.empty()) {
    detail += "; omitted (record predates them): ";
    for (size_t i = 0; i < plan.omitted.size(); ++i) {
      detail += (i == 0 ? "" : ",") + plan.omitted[i];
    }
  }
  return detail;
}

uint64_t hooks_total_calls() {
  uint64_t total = 0;
  for (const std::atomic<uint64_t> &count : g_count) {
    total += count.load();
  }
  return total;
}

std::string hooks_counters_json(uint64_t frames_total, uint64_t frames_armed) {
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-gate-minus1-counters/1"));
  json.field("frames_total", static_cast<int64_t>(frames_total));
  json.field("frames_armed", static_cast<int64_t>(frames_armed));
  json.field("image_details_available", g_image_binds.available);

  json.key("hooks_planned").array_begin();
  for (const std::string &name : g_planned_names) {
    json.string(name);
  }
  json.array_end();
  json.key("hooks_omitted").array_begin();
  for (const std::string &name : g_omitted_names) {
    json.string(name);
  }
  json.array_end();

  // An omitted hook's count is null: "not installed" must not read as "never called".
  json.key("counts").object_begin();
  for (const HookSpec &spec : kSpecs) {
    if (g_skipped[spec.id]) {
      continue;
    }
    if (g_omitted[spec.id]) {
      json.field_null(spec.name);
    } else {
      json.field(spec.name, static_cast<int64_t>(g_count[spec.id].load()));
    }
  }
  json.object_end();

  const Snapshot s = take_snapshot();

  json.key("captured").object_begin();
  json.key("canvas_item_add_rect").array_begin();
  for (const RectCapture &capture : s.rects) {
    json.object_begin();
    json.field("item", std::to_string(capture.item));
    json.key("rect")
        .array_begin()
        .float32(capture.rect.position.x)
        .float32(capture.rect.position.y)
        .float32(capture.rect.size.x)
        .float32(capture.rect.size.y)
        .array_end();
    json.key("rect_bits")
        .array_begin()
        .float32_bits(capture.rect.position.x)
        .float32_bits(capture.rect.position.y)
        .float32_bits(capture.rect.size.x)
        .float32_bits(capture.rect.size.y)
        .array_end();
    json.key("color")
        .array_begin()
        .float32(capture.color.r)
        .float32(capture.color.g)
        .float32(capture.color.b)
        .float32(capture.color.a)
        .array_end();
    json.key("color_bits")
        .array_begin()
        .float32_bits(capture.color.r)
        .float32_bits(capture.color.g)
        .float32_bits(capture.color.b)
        .float32_bits(capture.color.a)
        .array_end();
    json.field("antialiased", capture.antialiased);
    json.object_end();
  }
  json.array_end();

  json.key("canvas_item_add_polygon").array_begin();
  for (const PolygonCapture &capture : s.polygons) {
    json.object_begin();
    json.field("item", std::to_string(capture.item));
    json.key("points");
    write_vector2_array(&json, capture.points, false);
    json.key("point_bits");
    write_vector2_array(&json, capture.points, true);
    json.field("points_total", capture.points_total);
    json.key("colors");
    write_color_array(&json, capture.colors, false);
    json.key("color_bits");
    write_color_array(&json, capture.colors, true);
    json.field("colors_total", capture.colors_total);
    json.field("uvs_count", capture.uvs_count);
    json.field("texture", std::to_string(capture.texture));
    json.object_end();
  }
  json.array_end();

  json.key("texture_2d_create");
  write_image_captures(&json, s.creates, false);
  json.key("texture_2d_update");
  write_image_captures(&json, s.updates, true);
  if (!g_skipped[kSetCanvasGroupMode] && !g_omitted[kSetCanvasGroupMode]) {
    // CG1 (render-stream-10.md "Capture"): the out-of-range modes passed through unmirrored.
    json.field("canvas_group_mode_invalid",
               static_cast<int64_t>(g_canvas_group_mode_invalid.load()));
  }
  if (!g_skipped[kTextureSetPath] && !g_omitted[kTextureSetPath]) {
    // G8kc: every texture_set_path call (the paths of the hook log), in call order.
    std::lock_guard<std::mutex> lock(g_cache_mutex);
    json.key("texture_set_path").array_begin();
    for (const auto &call : g_set_path_calls) {
      json.object_begin();
      json.field("texture", std::to_string(call.first));
      json.field("path", call.second);
      json.object_end();
    }
    json.array_end();
  }

  // Optional hooks: deduplicated entries, each with calls/first_frame/last_frame.
  // Arrays keep at most 64 elements (the *_total fields carry the real sizes).
  json.key("canvas_item_add_triangle_array").array_begin();
  for (const GeometryEntry &e : s.triangle_arrays.entries) {
    write_geometry(&json, e, GeometryKind::kTriangleArray);
  }
  json.array_end();
  json.key("canvas_item_add_primitive").array_begin();
  for (const GeometryEntry &e : s.primitives.entries) {
    write_geometry(&json, e, GeometryKind::kPrimitive);
  }
  json.array_end();
  json.key("canvas_item_add_polyline").array_begin();
  for (const GeometryEntry &e : s.polylines.entries) {
    write_geometry(&json, e, GeometryKind::kPolyline);
  }
  json.array_end();
  // Calibrator 7 (gate5-design.md Q2): draw_multiline / draw_dashed_line.
  json.key("canvas_item_add_multiline").array_begin();
  for (const GeometryEntry &e : s.multilines.entries) {
    write_geometry(&json, e, GeometryKind::kMultiline);
  }
  json.array_end();

  write_log(&json, "canvas_item_add_nine_patch", s.nine_patches,
            [](JsonWriter *j, const PodEntry<NinePatchKey> &e) {
              write_rid(j, "item", e.key.item);
              write_floats(j, "rect", e.key.rect);
              write_floats(j, "source", e.key.source);
              write_rid(j, "texture", e.key.texture);
              write_floats(j, "topleft", e.key.topleft);
              write_floats(j, "bottomright", e.key.bottomright);
              j->field("x_axis_mode", static_cast<int64_t>(e.key.x_axis_mode));
              j->field("y_axis_mode", static_cast<int64_t>(e.key.y_axis_mode));
              j->field("draw_center", e.key.draw_center);
              write_floats(j, "modulate", e.key.modulate);
            });
  write_log(&json, "canvas_item_add_line", s.lines, [](JsonWriter *j, const PodEntry<LineKey> &e) {
    write_rid(j, "item", e.key.item);
    write_floats(j, "from", e.key.from);
    write_floats(j, "to", e.key.to);
    write_floats(j, "color", e.key.color);
    write_floats(j, "width", &e.key.width, 1);
    j->field("antialiased", e.key.antialiased);
  });
  write_log(&json, "canvas_item_add_circle", s.circles,
            [](JsonWriter *j, const PodEntry<CircleKey> &e) {
              write_rid(j, "item", e.key.item);
              write_floats(j, "position", e.key.position);
              write_floats(j, "radius", &e.key.radius, 1);
              write_floats(j, "color", e.key.color);
              j->field("antialiased", e.key.antialiased);
            });
  const auto item_transform_writer = [](JsonWriter *j, const PodEntry<ItemTransformKey> &e) {
    write_rid(j, "item", e.key.item);
    write_floats(j, "transform", e.key.transform);
  };
  write_log(&json, "canvas_item_add_set_transform", s.add_set_transforms, item_transform_writer);
  write_log(&json, "canvas_item_set_transform", s.set_transforms, item_transform_writer);
  write_log(&json, "canvas_item_set_modulate", s.set_modulates,
            [](JsonWriter *j, const PodEntry<ItemColorKey> &e) {
              write_rid(j, "item", e.key.item);
              write_floats(j, "color", e.key.color);
            });
  write_log(&json, "canvas_item_add_mesh", s.add_meshes,
            [](JsonWriter *j, const PodEntry<AddMeshKey> &e) {
              write_rid(j, "item", e.key.item);
              write_rid(j, "mesh", e.key.mesh);
              write_floats(j, "transform", e.key.transform);
              write_floats(j, "modulate", e.key.modulate);
              write_rid(j, "texture", e.key.texture);
            });
  write_log(&json, "canvas_item_add_multimesh", s.add_multimeshes,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "item", e.key.a);
              write_rid(j, "mesh", e.key.b);
              write_rid(j, "texture", e.key.c);
            });
  write_log(&json, "canvas_item_create", s.canvas_item_creates,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "rid", e.key.a); });
  write_log(&json, "canvas_item_clear", s.canvas_item_clears,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "item", e.key.a); });
  write_log(&json, "canvas_item_set_material", s.set_materials,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "item", e.key.a);
              write_rid(j, "material", e.key.b);
            });
  write_log(&json, "mesh_create", s.mesh_creates,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "rid", e.key.a); });
  write_log(&json, "mesh_add_surface", s.mesh_surfaces,
            [](JsonWriter *j, const PodEntry<MeshSurfaceKey> &e) {
              write_rid(j, "mesh", e.key.mesh);
              j->field("primitive", static_cast<int64_t>(e.key.primitive));
              j->field("format", std::to_string(e.key.format));
              j->field("vertex_count", static_cast<int64_t>(e.key.vertex_count));
              j->field("vertex_data_size", e.key.vertex_data_size);
              j->field("attribute_data_size", e.key.attribute_data_size);
              j->field("skin_data_size", e.key.skin_data_size);
              j->field("index_count", static_cast<int64_t>(e.key.index_count));
              j->field("index_data_size", e.key.index_data_size);
              write_aabb(j, e.key.aabb);
            });
  write_log(&json, "mesh_surface_update_vertex_region", s.vertex_regions,
            [](JsonWriter *j, const PodEntry<RegionKey> &e) { write_region(j, e); });
  write_log(&json, "mesh_surface_update_attribute_region", s.attribute_regions,
            [](JsonWriter *j, const PodEntry<RegionKey> &e) { write_region(j, e); });
  write_log(&json, "mesh_clear", s.mesh_clears,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "mesh", e.key.a); });
  write_log(&json, "mesh_set_custom_aabb", s.mesh_aabbs,
            [](JsonWriter *j, const PodEntry<MeshAabbKey> &e) {
              write_rid(j, "mesh", e.key.mesh);
              write_aabb(j, e.key.aabb);
            });
  write_log(&json, "shader_create_from_code", s.shader_creates,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "rid", e.key.a); });
  write_log(&json, "shader_set_code", s.shader_codes,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "shader", e.key.a); });
  write_log(&json, "material_set_param", s.material_params,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "material", e.key.a);
            });
  // Freed RIDs, deduplicated like the optional hooks (a RID is freed once, so
  // in practice this is the first 32 frees and a dropped count).
  write_log(&json, "free", s.frees,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "rid", e.key.a); });
  // Calibrator 3.
  write_log(&json, "viewport_attach_canvas", s.viewport_attaches,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "viewport", e.key.a);
              write_rid(j, "canvas", e.key.b);
            });
  write_log(&json, "viewport_set_canvas_transform", s.viewport_canvas_transforms,
            [](JsonWriter *j, const PodEntry<ViewportCanvasTransformKey> &e) {
              write_rid(j, "viewport", e.key.viewport);
              write_rid(j, "canvas", e.key.canvas);
              write_floats(j, "transform", e.key.transform);
            });
  write_log(&json, "canvas_create", s.canvas_creates,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "rid", e.key.a); });
  write_log(&json, "canvas_item_set_parent", s.set_parents,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "item", e.key.a);
              write_rid(j, "parent", e.key.b);
            });
  const auto item_bool_writer = [](const char *name) {
    return [name](JsonWriter *j, const PodEntry<ItemValueKey> &e) {
      write_rid(j, "item", e.key.item);
      j->field(name, e.key.value != 0);
    };
  };
  const auto item_int_writer = [](const char *name) {
    return [name](JsonWriter *j, const PodEntry<ItemValueKey> &e) {
      write_rid(j, "item", e.key.item);
      j->field(name, e.key.value);
    };
  };
  write_log(&json, "canvas_item_set_visible", s.set_visibles, item_bool_writer("visible"));
  write_log(&json, "canvas_item_set_clip", s.set_clips, item_bool_writer("clip"));
  write_log(&json, "canvas_item_set_custom_rect", s.set_custom_rects,
            [](JsonWriter *j, const PodEntry<ItemCustomRectKey> &e) {
              write_rid(j, "item", e.key.item);
              j->field("custom_rect", e.key.enabled);
              write_floats(j, "rect", e.key.rect);
            });
  write_log(&json, "canvas_item_set_self_modulate", s.set_self_modulates,
            [](JsonWriter *j, const PodEntry<ItemColorKey> &e) {
              write_rid(j, "item", e.key.item);
              write_floats(j, "color", e.key.color);
            });
  write_log(&json, "canvas_item_set_visibility_layer", s.set_visibility_layers,
            item_int_writer("visibility_layer"));
  write_log(&json, "canvas_item_set_z_index", s.set_z_indices, item_int_writer("z_index"));
  write_log(&json, "canvas_item_set_draw_index", s.set_draw_indices,
            item_int_writer("draw_index"));
  write_log(&json, "canvas_item_set_z_as_relative_to_parent", s.set_z_as_relatives,
            item_bool_writer("z_relative"));
  write_log(&json, "canvas_item_set_draw_behind_parent", s.set_draw_behinds,
            item_bool_writer("behind"));
  // Calibrator 5 (gate2-design.md Q2). The two texture-rect draws carry their
  // full arguments (negative sizes, that is flips, as the engine received them);
  // since G4e2 (gate4-design.md Q2) so does the msdf draw.
  write_log(&json, "canvas_item_add_texture_rect", s.texture_rects,
            [](JsonWriter *j, const PodEntry<TextureRectKey> &e) {
              write_rid(j, "item", e.key.item);
              write_floats(j, "rect", e.key.rect);
              write_rid(j, "texture", e.key.texture);
              j->field("tile", e.key.tile);
              write_floats(j, "modulate", e.key.modulate);
              j->field("transpose", e.key.transpose);
            });
  write_log(&json, "canvas_item_add_texture_rect_region", s.texture_rect_regions,
            [](JsonWriter *j, const PodEntry<TextureRectRegionKey> &e) {
              write_rid(j, "item", e.key.item);
              write_floats(j, "rect", e.key.rect);
              write_rid(j, "texture", e.key.texture);
              write_floats(j, "source", e.key.source);
              write_floats(j, "modulate", e.key.modulate);
              j->field("transpose", e.key.transpose);
              j->field("clip_uv", e.key.clip_uv);
            });
  write_log(&json, "canvas_item_add_msdf_texture_rect_region", s.msdf_rects,
            [](JsonWriter *j, const PodEntry<MsdfRectKey> &e) {
              write_rid(j, "item", e.key.item);
              write_floats(j, "rect", e.key.rect);
              write_rid(j, "texture", e.key.texture);
              write_floats(j, "source", e.key.source);
              write_floats(j, "modulate", e.key.modulate);
              j->field("outline_size", static_cast<int64_t>(e.key.outline_size));
              write_floats(j, "px_range", &e.key.px_range, 1);
              write_floats(j, "scale", &e.key.scale, 1);
            });
  write_log(&json, "texture_2d_placeholder_create", s.placeholder_creates,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "rid", e.key.a); });
  write_log(&json, "texture_replace", s.texture_replaces,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "texture", e.key.a);
              write_rid(j, "by_texture", e.key.b);
            });
  const auto rid_int_writer = [](const char *rid_name, const char *name) {
    return [rid_name, name](JsonWriter *j, const PodEntry<ItemValueKey> &e) {
      write_rid(j, rid_name, e.key.item);
      j->field(name, e.key.value);
    };
  };
  write_log(&json, "viewport_set_default_canvas_item_texture_filter", s.viewport_texture_filters,
            rid_int_writer("viewport", "filter"));
  write_log(&json, "viewport_set_default_canvas_item_texture_repeat", s.viewport_texture_repeats,
            rid_int_writer("viewport", "repeat"));
  write_log(&json, "canvas_texture_create", s.canvas_texture_creates,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "rid", e.key.a); });
  write_log(&json, "canvas_texture_set_channel", s.canvas_texture_channels,
            [](JsonWriter *j, const PodEntry<ChannelKey> &e) {
              write_rid(j, "canvas_texture", e.key.canvas_texture);
              j->field("channel", e.key.channel);
              write_rid(j, "texture", e.key.texture);
            });
  write_log(&json, "canvas_texture_set_texture_filter", s.canvas_texture_filters,
            rid_int_writer("canvas_texture", "filter"));
  write_log(&json, "canvas_texture_set_texture_repeat", s.canvas_texture_repeats,
            rid_int_writer("canvas_texture", "repeat"));
  write_log(&json, "canvas_item_set_default_texture_filter", s.item_texture_filters,
            rid_int_writer("item", "filter"));
  write_log(&json, "canvas_item_set_default_texture_repeat", s.item_texture_repeats,
            rid_int_writer("item", "repeat"));
  write_log(&json, "canvas_item_add_lcd_texture_rect_region", s.lcd_rects,
            [](JsonWriter *j, const PodEntry<LcdRectKey> &e) {
              write_rid(j, "item", e.key.item);
              write_floats(j, "rect", e.key.rect);
              write_rid(j, "texture", e.key.texture);
              write_floats(j, "source", e.key.source);
              write_floats(j, "modulate", e.key.modulate);
            });
  // Calibrator 6 (gate3-design.md Q2): the bool crosses only into counters.json's captured; the
  // mirror tap (add_unsupported) ignores it.
  write_log(&json, "canvas_item_add_clip_ignore", s.clip_ignores, item_bool_writer("ignore"));
  // Calibrator 7 (gate5-design.md Q2).
  write_log(&json, "mesh_create_from_surfaces", s.mesh_create_from_surfaces_calls,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "rid", e.key.a);
              j->field("surface_count", static_cast<int64_t>(e.key.b));
            });
  write_log(&json, "mesh_surface_update_skin_region", s.skin_regions,
            [](JsonWriter *j, const PodEntry<RegionKey> &e) { write_region(j, e); });
  write_log(&json, "mesh_surface_update_index_region", s.index_regions,
            [](JsonWriter *j, const PodEntry<RegionKey> &e) { write_region(j, e); });
  write_log(&json, "mesh_surface_remove", s.mesh_surface_removes, item_int_writer("surface"));
  write_log(&json, "canvas_item_add_particles", s.add_particles,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "item", e.key.a);
              write_rid(j, "particles", e.key.b);
              write_rid(j, "texture", e.key.c);
            });
  write_log(&json, "canvas_item_add_animation_slice", s.animation_slices,
            [](JsonWriter *j, const PodEntry<AnimationSliceKey> &e) {
              write_rid(j, "item", e.key.item);
              write_floats(j, "animation_length", &e.key.animation_length, 1);
              write_floats(j, "slice_begin", &e.key.slice_begin, 1);
              write_floats(j, "slice_end", &e.key.slice_end, 1);
              write_floats(j, "offset", &e.key.offset, 1);
            });
  write_log(&json, "canvas_item_attach_skeleton", s.attach_skeletons,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "item", e.key.a);
              write_rid(j, "skeleton", e.key.b);
            });
  // Calibrator 8 (gate5_5-design.md Q2). The decoded name/value never appear here (Q2); only
  // RIDs and plain scalars, as material_set_param/shader_set_code already keep to RID only.
  write_log(&json, "shader_create", s.shader_create_calls,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "rid", e.key.a); });
  write_log(&json, "shader_set_default_texture_parameter", s.shader_default_textures,
            [](JsonWriter *j, const PodEntry<ShaderDefaultTextureKey> &e) {
              write_rid(j, "shader", e.key.shader);
              write_rid(j, "texture", e.key.texture);
              j->field("index", static_cast<int64_t>(e.key.index));
            });
  write_log(&json, "material_create", s.material_create_calls,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "rid", e.key.a); });
  write_log(&json, "material_create_from_shader", s.material_create_from_shader_calls,
            [](JsonWriter *j, const PodEntry<MaterialShaderKey> &e) {
              write_rid(j, "material", e.key.material);
              write_rid(j, "shader", e.key.shader);
            });
  write_log(&json, "material_set_shader", s.material_set_shaders,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "material", e.key.a);
              write_rid(j, "shader", e.key.b);
            });
  write_log(&json, "canvas_set_modulate", s.canvas_set_modulates,
            [](JsonWriter *j, const PodEntry<ItemColorKey> &e) {
              write_rid(j, "canvas", e.key.item);
              write_floats(j, "color", e.key.color);
            });
  write_log(&json, "canvas_item_set_use_parent_material", s.set_use_parent_materials,
            item_bool_writer("enable"));
  write_log(&json, "canvas_item_set_instance_shader_parameter", s.set_instance_shader_parameters,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) { write_rid(j, "item", e.key.a); });
  write_log(&json, "canvas_light_attach_to_canvas", s.canvas_light_attaches,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "light", e.key.a);
              write_rid(j, "canvas", e.key.b);
            });
  // Calibrator 9 (gate6-design.md Q2): decode only, no classification (that is G6b's mirror).
  write_log(&json, "viewport_remove_canvas", s.viewport_remove_canvases,
            [](JsonWriter *j, const PodEntry<RidTripleKey> &e) {
              write_rid(j, "viewport", e.key.a);
              write_rid(j, "canvas", e.key.b);
            });
  write_log(&json, "viewport_set_global_canvas_transform", s.viewport_global_canvas_transforms,
            [](JsonWriter *j, const PodEntry<ViewportTransformKey> &e) {
              write_rid(j, "viewport", e.key.viewport);
              write_floats(j, "transform", e.key.transform);
            });
  write_log(&json, "viewport_set_canvas_stacking", s.canvas_stackings,
            [](JsonWriter *j, const PodEntry<CanvasStackingKey> &e) {
              write_rid(j, "viewport", e.key.viewport);
              write_rid(j, "canvas", e.key.canvas);
              j->field("layer", static_cast<int64_t>(e.key.layer));
              j->field("sublayer", static_cast<int64_t>(e.key.sublayer));
            });
  write_log(&json, "canvas_set_item_mirroring", s.canvas_item_mirrorings,
            [](JsonWriter *j, const PodEntry<CanvasItemMirroringKey> &e) {
              write_rid(j, "canvas", e.key.canvas);
              write_rid(j, "item", e.key.item);
              write_floats(j, "mirroring", e.key.mirroring);
            });
  write_log(&json, "canvas_set_item_repeat", s.canvas_item_repeats,
            [](JsonWriter *j, const PodEntry<CanvasItemRepeatKey> &e) {
              write_rid(j, "item", e.key.item);
              write_floats(j, "repeat_size", e.key.repeat_size);
              j->field("repeat_times", static_cast<int64_t>(e.key.repeat_times));
            });
  write_log(&json, "canvas_set_parent", s.canvas_set_parents,
            [](JsonWriter *j, const PodEntry<CanvasParentKey> &e) {
              write_rid(j, "canvas", e.key.canvas);
              write_rid(j, "parent", e.key.parent);
              write_floats(j, "scale", &e.key.scale, 1);
            });
  json.object_end();

  // Distinct calls that arrived after an optional hook's log was full.
  json.key("captured_dropped").object_begin();
  json.field("canvas_item_add_triangle_array", static_cast<int64_t>(s.triangle_arrays.dropped));
  json.field("canvas_item_add_primitive", static_cast<int64_t>(s.primitives.dropped));
  json.field("canvas_item_add_polyline", static_cast<int64_t>(s.polylines.dropped));
  json.field("canvas_item_add_nine_patch", static_cast<int64_t>(s.nine_patches.dropped));
  json.field("canvas_item_add_line", static_cast<int64_t>(s.lines.dropped));
  json.field("canvas_item_add_circle", static_cast<int64_t>(s.circles.dropped));
  json.field("canvas_item_add_set_transform", static_cast<int64_t>(s.add_set_transforms.dropped));
  json.field("canvas_item_set_transform", static_cast<int64_t>(s.set_transforms.dropped));
  json.field("canvas_item_set_modulate", static_cast<int64_t>(s.set_modulates.dropped));
  json.field("canvas_item_add_mesh", static_cast<int64_t>(s.add_meshes.dropped));
  json.field("canvas_item_add_multimesh", static_cast<int64_t>(s.add_multimeshes.dropped));
  json.field("canvas_item_create", static_cast<int64_t>(s.canvas_item_creates.dropped));
  json.field("canvas_item_clear", static_cast<int64_t>(s.canvas_item_clears.dropped));
  json.field("canvas_item_set_material", static_cast<int64_t>(s.set_materials.dropped));
  json.field("mesh_create", static_cast<int64_t>(s.mesh_creates.dropped));
  json.field("mesh_add_surface", static_cast<int64_t>(s.mesh_surfaces.dropped));
  json.field("mesh_surface_update_vertex_region",
             static_cast<int64_t>(s.vertex_regions.dropped));
  json.field("mesh_surface_update_attribute_region",
             static_cast<int64_t>(s.attribute_regions.dropped));
  json.field("mesh_clear", static_cast<int64_t>(s.mesh_clears.dropped));
  json.field("mesh_set_custom_aabb", static_cast<int64_t>(s.mesh_aabbs.dropped));
  json.field("shader_create_from_code", static_cast<int64_t>(s.shader_creates.dropped));
  json.field("shader_set_code", static_cast<int64_t>(s.shader_codes.dropped));
  json.field("material_set_param", static_cast<int64_t>(s.material_params.dropped));
  json.field("free", static_cast<int64_t>(s.frees.dropped));
  json.field("viewport_attach_canvas", static_cast<int64_t>(s.viewport_attaches.dropped));
  json.field("viewport_set_canvas_transform",
             static_cast<int64_t>(s.viewport_canvas_transforms.dropped));
  json.field("canvas_create", static_cast<int64_t>(s.canvas_creates.dropped));
  json.field("canvas_item_set_parent", static_cast<int64_t>(s.set_parents.dropped));
  json.field("canvas_item_set_visible", static_cast<int64_t>(s.set_visibles.dropped));
  json.field("canvas_item_set_clip", static_cast<int64_t>(s.set_clips.dropped));
  json.field("canvas_item_set_custom_rect", static_cast<int64_t>(s.set_custom_rects.dropped));
  json.field("canvas_item_set_self_modulate", static_cast<int64_t>(s.set_self_modulates.dropped));
  json.field("canvas_item_set_visibility_layer",
             static_cast<int64_t>(s.set_visibility_layers.dropped));
  json.field("canvas_item_set_z_index", static_cast<int64_t>(s.set_z_indices.dropped));
  json.field("canvas_item_set_draw_index", static_cast<int64_t>(s.set_draw_indices.dropped));
  json.field("canvas_item_set_z_as_relative_to_parent",
             static_cast<int64_t>(s.set_z_as_relatives.dropped));
  json.field("canvas_item_set_draw_behind_parent",
             static_cast<int64_t>(s.set_draw_behinds.dropped));
  json.field("canvas_item_add_texture_rect", static_cast<int64_t>(s.texture_rects.dropped));
  json.field("canvas_item_add_texture_rect_region",
             static_cast<int64_t>(s.texture_rect_regions.dropped));
  json.field("canvas_item_add_msdf_texture_rect_region",
             static_cast<int64_t>(s.msdf_rects.dropped));
  json.field("texture_2d_placeholder_create",
             static_cast<int64_t>(s.placeholder_creates.dropped));
  json.field("texture_replace", static_cast<int64_t>(s.texture_replaces.dropped));
  json.field("viewport_set_default_canvas_item_texture_filter",
             static_cast<int64_t>(s.viewport_texture_filters.dropped));
  json.field("viewport_set_default_canvas_item_texture_repeat",
             static_cast<int64_t>(s.viewport_texture_repeats.dropped));
  json.field("canvas_texture_create", static_cast<int64_t>(s.canvas_texture_creates.dropped));
  json.field("canvas_texture_set_channel",
             static_cast<int64_t>(s.canvas_texture_channels.dropped));
  json.field("canvas_texture_set_texture_filter",
             static_cast<int64_t>(s.canvas_texture_filters.dropped));
  json.field("canvas_texture_set_texture_repeat",
             static_cast<int64_t>(s.canvas_texture_repeats.dropped));
  json.field("canvas_item_set_default_texture_filter",
             static_cast<int64_t>(s.item_texture_filters.dropped));
  json.field("canvas_item_set_default_texture_repeat",
             static_cast<int64_t>(s.item_texture_repeats.dropped));
  json.field("canvas_item_add_lcd_texture_rect_region",
             static_cast<int64_t>(s.lcd_rects.dropped));
  json.field("canvas_item_add_clip_ignore", static_cast<int64_t>(s.clip_ignores.dropped));
  json.field("mesh_create_from_surfaces",
             static_cast<int64_t>(s.mesh_create_from_surfaces_calls.dropped));
  json.field("mesh_surface_update_skin_region", static_cast<int64_t>(s.skin_regions.dropped));
  json.field("mesh_surface_update_index_region", static_cast<int64_t>(s.index_regions.dropped));
  json.field("mesh_surface_remove", static_cast<int64_t>(s.mesh_surface_removes.dropped));
  json.field("canvas_item_add_multiline", static_cast<int64_t>(s.multilines.dropped));
  json.field("canvas_item_add_particles", static_cast<int64_t>(s.add_particles.dropped));
  json.field("canvas_item_add_animation_slice", static_cast<int64_t>(s.animation_slices.dropped));
  json.field("canvas_item_attach_skeleton", static_cast<int64_t>(s.attach_skeletons.dropped));
  json.field("shader_create", static_cast<int64_t>(s.shader_create_calls.dropped));
  json.field("shader_set_default_texture_parameter",
             static_cast<int64_t>(s.shader_default_textures.dropped));
  json.field("material_create", static_cast<int64_t>(s.material_create_calls.dropped));
  json.field("material_create_from_shader",
             static_cast<int64_t>(s.material_create_from_shader_calls.dropped));
  json.field("material_set_shader", static_cast<int64_t>(s.material_set_shaders.dropped));
  json.field("canvas_set_modulate", static_cast<int64_t>(s.canvas_set_modulates.dropped));
  json.field("canvas_item_set_use_parent_material",
             static_cast<int64_t>(s.set_use_parent_materials.dropped));
  json.field("canvas_item_set_instance_shader_parameter",
             static_cast<int64_t>(s.set_instance_shader_parameters.dropped));
  json.field("canvas_light_attach_to_canvas",
             static_cast<int64_t>(s.canvas_light_attaches.dropped));
  json.field("viewport_remove_canvas",
             static_cast<int64_t>(s.viewport_remove_canvases.dropped));
  json.field("viewport_set_global_canvas_transform",
             static_cast<int64_t>(s.viewport_global_canvas_transforms.dropped));
  json.field("viewport_set_canvas_stacking", static_cast<int64_t>(s.canvas_stackings.dropped));
  json.field("canvas_set_item_mirroring",
             static_cast<int64_t>(s.canvas_item_mirrorings.dropped));
  json.field("canvas_set_item_repeat", static_cast<int64_t>(s.canvas_item_repeats.dropped));
  json.field("canvas_set_parent", static_cast<int64_t>(s.canvas_set_parents.dropped));
  json.object_end();

  // G2a: the payload-copy capability and the texture hook log's counters.
  json.field("image_payload_available", g_image_binds.payload_available);
  json.field("texture_update_unknown",
             static_cast<int64_t>(rs::resource_log().update_unknown()));

  json.object_end();
  return json.take();
}

}  // namespace grc
