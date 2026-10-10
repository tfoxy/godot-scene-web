#include "hooks.h"

#include <atomic>
#include <chrono>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <type_traits>

#include "abi.h"
#include "iface.h"
#include "report.h"
#include "rs_mesh_payload.h"
#include "rs_mirror.h"
#include "rs_resource_log.h"
#include "rs_sha256.h"
#include "rs_texture_payload.h"

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
  kHookCount,
};

void *g_original[kHookCount] = {};
std::atomic<uint64_t> g_count[kHookCount];
bool g_omitted[kHookCount] = {};
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

// Q3 "Copy", steps 1-3. Nothing is copied for an unreadable Image, a format
// outside GRC_RESOURCE_FORMATS or a payload over GRC_RESOURCE_MAX_PAYLOAD_BYTES.
// The GRT1 bytes go to `bytes` (G2b2: the texture mirror keeps them); null
// unless the copy is "ok".
rs::PayloadCopy copy_payload(const ImageFacts &facts, const Ref *image, rs::PayloadPtr *bytes) {
  bytes->reset();
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
  const uint8_t *data = g_iface.image_ptr(image->object);
  if (data == nullptr) {
    copy.reason = "payload-unavailable";
    return copy;
  }
  const uint64_t t0 = now_ns();
  auto payload = std::make_shared<rs::PayloadBytes>();
  rs::payload_header(meta, static_cast<uint64_t>(facts.data_size), payload.get());
  payload->insert(payload->end(), data, data + facts.data_size);
  const uint64_t t1 = now_ns();
  copy.hash = sha256_hex(payload->data(), payload->size());
  const uint64_t t2 = now_ns();
  copy.status = "ok";
  copy.payload_bytes = static_cast<int64_t>(payload->size());
  copy.copy_ns = static_cast<int64_t>(t1 - t0);
  copy.hash_ns = static_cast<int64_t>(t2 - t1);
  *bytes = std::move(payload);
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
// copied or hashed for a refused surface (D7) or one over GRC_RESOURCE_MAX_PAYLOAD_BYTES.
rs::MeshSurfaceCopy copy_mesh_surface(const SurfaceDataPrefix &sd, MeshSurfaceBuffer *buffer) {
  rs::MeshSurfaceCopy copy;
  copy.primitive = sd.primitive;
  copy.format = sd.format;
  copy.vertex_count = sd.vertex_count;
  copy.index_count = sd.index_count;

  rs::SurfaceFacts facts;
  facts.primitive = sd.primitive;
  facts.format = sd.format;
  facts.vertex_data_bytes = sd.vertex_data.size();
  facts.attribute_data_bytes = sd.attribute_data.size();
  facts.skin_data_bytes = sd.skin_data.size();
  facts.index_data_bytes = sd.index_data.size();
  facts.vertex_count = sd.vertex_count;
  facts.index_count = sd.index_count;
  facts.blend_shape_data_bytes = sd.blend_shape_data.size();
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
  if (!classification.ok) {
    copy.status = "unsupported";
    copy.reason = classification.reason;
    return copy;
  }

  const std::string meta = rs::payload_meta(
      sd.primitive, sd.format, sd.vertex_count, sd.index_count,
      static_cast<int64_t>(sd.vertex_data.size()), static_cast<int64_t>(sd.attribute_data.size()),
      static_cast<int64_t>(sd.skin_data.size()), static_cast<int64_t>(sd.index_data.size()));
  const uint64_t data_bytes = static_cast<uint64_t>(sd.vertex_data.size()) +
                              static_cast<uint64_t>(sd.attribute_data.size()) +
                              static_cast<uint64_t>(sd.skin_data.size()) +
                              static_cast<uint64_t>(sd.index_data.size());
  if (rs::mesh_payload_size(meta, data_bytes) > g_resource_policy.max_payload_bytes) {
    copy.status = "unsupported";
    copy.reason = "payload-too-large";
    return copy;
  }

  const uint64_t t0 = now_ns();
  buffer->vertex_data.assign(sd.vertex_data.ptr(), sd.vertex_data.ptr() + sd.vertex_data.size());
  buffer->attribute_data.assign(sd.attribute_data.ptr(),
                                sd.attribute_data.ptr() + sd.attribute_data.size());
  buffer->skin_data.assign(sd.skin_data.ptr(), sd.skin_data.ptr() + sd.skin_data.size());
  buffer->index_data.assign(sd.index_data.ptr(), sd.index_data.ptr() + sd.index_data.size());
  const std::vector<uint8_t> payload = rs::encode_payload(
      sd.primitive, sd.format, sd.vertex_count, sd.index_count, sd.aabb, sd.uv_scale,
      buffer->vertex_data.data(), buffer->vertex_data.size(), buffer->attribute_data.data(),
      buffer->attribute_data.size(), buffer->skin_data.data(), buffer->skin_data.size(),
      buffer->index_data.data(), buffer->index_data.size());
  const uint64_t t1 = now_ns();
  copy.hash = sha256_hex(payload.data(), payload.size());
  const uint64_t t2 = now_ns();
  copy.status = "ok";
  copy.copy_ns = static_cast<int64_t>(t1 - t0);
  copy.hash_ns = static_cast<int64_t>(t2 - t1);
  buffer->ok = true;
  return copy;
}

// Re-encodes and re-hashes a surface already in `buffer` (whole payload, D6): used after a region
// update is applied in place. `buffer.ok` must already be true (a refused surface is never
// re-hashed; its region updates are "version + 1 only").
rs::MeshSurfaceCopy rehash_mesh_surface(const MeshSurfaceBuffer &buffer) {
  rs::MeshSurfaceCopy copy;
  copy.primitive = buffer.primitive;
  copy.format = buffer.format;
  copy.vertex_count = buffer.vertex_count;
  copy.index_count = buffer.index_count;
  const uint64_t t0 = now_ns();
  const std::vector<uint8_t> payload = rs::encode_payload(
      buffer.primitive, buffer.format, buffer.vertex_count, buffer.index_count, buffer.aabb,
      buffer.uv_scale, buffer.vertex_data.data(), buffer.vertex_data.size(),
      buffer.attribute_data.data(), buffer.attribute_data.size(), buffer.skin_data.data(),
      buffer.skin_data.size(), buffer.index_data.data(), buffer.index_data.size());
  const uint64_t t1 = now_ns();
  copy.hash = sha256_hex(payload.data(), payload.size());
  const uint64_t t2 = now_ns();
  copy.status = "ok";
  copy.copy_ns = static_cast<int64_t>(t1 - t0);
  copy.hash_ns = static_cast<int64_t>(t2 - t1);
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

RID hook_texture_2d_create(void *self, const Ref *image) {
  bump(kTexture2dCreate);
  const ImageFacts facts = read_image(image);
  ImageCapture capture = describe_image(facts, 0, -1);
  // D3: the bytes are copied and hashed here, on the calling thread, before the
  // engine sees the call (a worker-thread create is initialized later, from
  // whatever the Image then holds).
  const bool logging = resources().active();
  rs::PayloadPtr bytes;
  const rs::PayloadCopy copy = logging ? copy_payload(facts, image, &bytes) : rs::PayloadCopy();
  const RID result = original<FnTexture2dCreate>(kTexture2dCreate)(self, image);
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
      mirror().texture_2d_create(result.id, copy, std::move(bytes), current_frame());
    }
    resources().texture_2d_create(tap_context(), result.id, copy, omit);
  }
  return result;
}

void hook_texture_2d_update(void *self, RID texture, const Ref *image, int layer) {
  bump(kTexture2dUpdate);
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
  const rs::PayloadCopy copy = logging ? copy_payload(facts, image, &bytes) : rs::PayloadCopy();
  original<FnTexture2dUpdate>(kTexture2dUpdate)(self, texture, image, layer);
  if (logging) {
    std::lock_guard<std::mutex> order(g_texture_order);
    const bool omit = omitted("texture_2d_update");
    if (streaming() && !omit) {
      mirror().texture_2d_update(texture.id, copy, std::move(bytes), layer, current_frame());
    }
    resources().texture_2d_update(tap_context(), texture.id, copy, layer, omit);
  }
}

void hook_free(void *self, RID rid) {
  bump(kFree);
  log_entry(&g_frees, rids(rid.id));
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
  // /4 carries add_mesh (render-stream-4.md), but the mirror's mesh table is G5e's
  // (gate5-design.md Q3b); until then the capture keeps refusing it as a typed unsupported-op.
  tap_unsupported(item, "canvas_item_add_mesh");
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
  original<FnSetMaterial>(kSetMaterial)(self, item, material);
}

RID hook_mesh_create(void *self) {
  bump(kMeshCreate);
  const RID result = original<FnCreate>(kMeshCreate)(self);
  log_entry(&g_mesh_creates, rids(result.id));
  const bool logging = resources().active();
  if (logging) {
    const bool omit = omitted("mesh_create");
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!omit) {
      g_mesh_buffers[result.id];  // an empty surface list, value-initialized
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
    const bool omit = omitted("mesh_add_surface");
    MeshSurfaceBuffer buffer;
    const rs::MeshSurfaceCopy copy = copy_mesh_surface(*surface, &buffer);
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!omit) {
      g_mesh_buffers[mesh.id].push_back(std::move(buffer));
    }
    resources().mesh_add_surface(tap_context(), mesh.id, copy, omit);
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
  const bool omit = omitted(mesh_region_op_name(which));
  std::lock_guard<std::mutex> lock(g_mutex);
  const char *outcome = "unknown";
  rs::MeshSurfaceCopy updated;
  const rs::MeshSurfaceCopy *new_surface = nullptr;
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
          updated = rehash_mesh_surface(buffer);
          new_surface = &updated;
        }
      }
    }
  }
  resources().mesh_surface_update_region(tap_context(), mesh.id, mesh_buffer_name(which), surface,
                                         offset, bytes, outcome, new_surface, omit);
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
    const bool omit = omitted("mesh_clear");
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!omit) {
      auto it = g_mesh_buffers.find(mesh.id);
      if (it != g_mesh_buffers.end()) {
        it->second.clear();
      }
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
    const bool omit = omitted("mesh_create_from_surfaces");
    std::vector<MeshSurfaceBuffer> buffers;
    std::vector<rs::MeshSurfaceCopy> copies;
    const int64_t count = surfaces != nullptr ? surfaces->size() : 0;
    for (int64_t i = 0; i < count; ++i) {
      MeshSurfaceBuffer buffer;
      copies.push_back(copy_mesh_surface(surfaces->ptr()[i], &buffer));
      buffers.push_back(std::move(buffer));
    }
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!omit) {
      g_mesh_buffers[result.id] = std::move(buffers);
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
    const bool omit = omitted("mesh_surface_remove");
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!omit) {
      auto it = g_mesh_buffers.find(mesh.id);
      if (it != g_mesh_buffers.end() && surface >= 0 &&
          static_cast<size_t>(surface) < it->second.size()) {
        it->second.erase(it->second.begin() + surface);
      }
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
  bump(kShaderCreateFromCode);
  const RID result =
      original<FnShaderCreateFromCode>(kShaderCreateFromCode)(self, code, path_hint);
  log_entry(&g_shader_creates, rids(result.id));
  return result;
}

void hook_shader_set_code(void *self, RID shader, const void *code) {
  bump(kShaderSetCode);
  log_entry(&g_shader_codes, rids(shader.id));
  original<FnShaderSetCode>(kShaderSetCode)(self, shader, code);
}

void hook_material_set_param(void *self, RID material, const void *name, const void *value) {
  bump(kMaterialSetParam);
  log_entry(&g_material_params, rids(material.id));
  original<FnMaterialSetParam>(kMaterialSetParam)(self, material, name, value);
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
  const RID result = original<FnCreate>(kCanvasTextureCreate)(self);
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

void hooks_set_frame(uint64_t frame) { g_frame.store(frame, std::memory_order_relaxed); }

bool hooks_plan(const Calibration &calib, HookPlan *plan) {
  *plan = HookPlan();
  g_planned_names.clear();
  g_omitted_names.clear();
  for (const HookSpec &spec : kSpecs) {
    const int64_t index = calib.slot(spec.name);
    const bool required = spec.id < kRequiredHookCount;
    g_omitted[spec.id] = false;
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

std::string hooks_plan_detail(const HookPlan &plan) {
  std::string detail = std::to_string(plan.planned.size()) + " of " +
                       std::to_string(static_cast<size_t>(kHookCount)) + " hooks named by the record";
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
  json.object_end();

  // G2a: the payload-copy capability and the texture hook log's counters.
  json.field("image_payload_available", g_image_binds.payload_available);
  json.field("texture_update_unknown",
             static_cast<int64_t>(rs::resource_log().update_unknown()));

  json.object_end();
  return json.take();
}

}  // namespace grc
