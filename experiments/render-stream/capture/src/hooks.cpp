#include "hooks.h"

#include <atomic>
#include <cstring>
#include <mutex>
#include <type_traits>

#include "abi.h"
#include "iface.h"
#include "report.h"
#include "rs_mirror.h"

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
};

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
  if (log->entries.size() >= kMaxEntries) {
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

rs1::Xform to_xform(const Transform2D &t) {
  return {t.columns[0].x, t.columns[0].y, t.columns[1].x, t.columns[1].y, t.columns[2].x,
          t.columns[2].y};
}

rs1::Color4 to_color(const Color &c) { return {c.r, c.g, c.b, c.a}; }

rs1::Rect4 to_rect(const Rect2 &r) { return {r.position.x, r.position.y, r.size.x, r.size.y}; }

// Every hooked draw op except add_rect: recorded as an unsupported command.
void tap_unsupported(RID item, const char *op) {
  if (streaming()) {
    mirror().add_unsupported(item.id, op, current_frame());
  }
}

struct ImageBinds {
  bool resolved = false;
  bool available = false;
  GDExtensionMethodBindPtr get_width = nullptr;
  GDExtensionMethodBindPtr get_height = nullptr;
  GDExtensionMethodBindPtr get_format = nullptr;
  GDExtensionMethodBindPtr get_data_size = nullptr;
};

ImageBinds g_image_binds;

bool same_rect_capture(const RectCapture &a, const RectCapture &b) {
  return a.item == b.item && a.antialiased == b.antialiased &&
         std::memcmp(&a.rect, &b.rect, sizeof(Rect2)) == 0 &&
         std::memcmp(&a.color, &b.color, sizeof(Color)) == 0;
}

ImageCapture describe_image(const Ref *image, uint64_t rid, int64_t layer) {
  ImageCapture out = {rid, current_frame(), layer, false, -1, -1, -1, -1};
  if (image == nullptr || image->object == nullptr || !g_image_binds.available) {
    return out;
  }
  int64_t value = 0;
  bool ok = true;
  ok = ok && call_int_getter(g_image_binds.get_width, image->object, &value);
  out.width = ok ? value : -1;
  ok = ok && call_int_getter(g_image_binds.get_height, image->object, &value);
  out.height = ok ? value : -1;
  ok = ok && call_int_getter(g_image_binds.get_format, image->object, &value);
  out.format = ok ? value : -1;
  ok = ok && call_int_getter(g_image_binds.get_data_size, image->object, &value);
  out.data_size = ok ? value : -1;
  out.details = ok;
  return out;
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
  tap_unsupported(item, "canvas_item_add_texture_rect");
  original<FnAddTextureRect>(kAddTextureRect)(self, item, rect, texture, tile, modulate,
                                              transpose);
}

void hook_add_texture_rect_region(void *self, RID item, const Rect2 *rect, RID texture,
                                  const Rect2 *source, const Color *modulate, bool transpose,
                                  bool clip_uv) {
  bump(kAddTextureRectRegion);
  tap_unsupported(item, "canvas_item_add_texture_rect_region");
  original<FnAddTextureRectRegion>(kAddTextureRectRegion)(self, item, rect, texture, source,
                                                          modulate, transpose, clip_uv);
}

void hook_add_msdf_texture_rect_region(void *self, RID item, const Rect2 *rect, RID texture,
                                       const Rect2 *source, const Color *modulate,
                                       int outline_size, float px_range, float scale) {
  bump(kAddMsdfTextureRectRegion);
  tap_unsupported(item, "canvas_item_add_msdf_texture_rect_region");
  original<FnAddMsdfTextureRectRegion>(kAddMsdfTextureRectRegion)(
      self, item, rect, texture, source, modulate, outline_size, px_range, scale);
}

void hook_add_polygon(void *self, RID item, const Vector<Point2> *points,
                      const Vector<Color> *colors, const Vector<Point2> *uvs, RID texture) {
  bump(kAddPolygon);
  tap_unsupported(item, "canvas_item_add_polygon");
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
  ImageCapture capture = describe_image(image, 0, -1);
  const RID result = original<FnTexture2dCreate>(kTexture2dCreate)(self, image);
  capture.rid = result.id;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_creates.size() < kMaxTextures) {
      g_creates.push_back(capture);
    }
  }
  return result;
}

void hook_texture_2d_update(void *self, RID texture, const Ref *image, int layer) {
  bump(kTexture2dUpdate);
  {
    ImageCapture capture = describe_image(image, texture.id, layer);
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_updates.size() < kMaxTextures) {
      g_updates.push_back(capture);
    }
  }
  original<FnTexture2dUpdate>(kTexture2dUpdate)(self, texture, image, layer);
}

void hook_free(void *self, RID rid) {
  bump(kFree);
  log_entry(&g_frees, rids(rid.id));
  if (streaming()) {
    // Before forwarding, so the mapping is gone before the engine can hand the
    // value out again.
    mirror().free_rid(rid.id, current_frame());
  }
  original<FnFree>(kFree)(self, rid);
}

// --- optional hooks ----------------------------------------------------------

void hook_add_triangle_array(void *self, RID item, const Vector<int32_t> *indices,
                             const Vector<Point2> *points, const Vector<Color> *colors,
                             const Vector<Point2> *uvs, const Vector<int32_t> *bones,
                             const Vector<float> *weights, RID texture, int count) {
  bump(kAddTriangleArray);
  tap_unsupported(item, "canvas_item_add_triangle_array");
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
  tap_unsupported(item, "canvas_item_add_nine_patch");
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
  tap_unsupported(item, "canvas_item_add_primitive");
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
  tap_unsupported(item, "canvas_item_add_line");
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
  tap_unsupported(item, "canvas_item_add_polyline");
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
  tap_unsupported(item, "canvas_item_add_circle");
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
  tap_unsupported(item, "canvas_item_add_set_transform");
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

void hook_mesh_update_vertex_region(void *self, RID mesh, int surface, int offset,
                                    const Vector<uint8_t> *data) {
  bump(kMeshUpdateVertexRegion);
  log_entry(&g_vertex_regions, region(mesh, surface, offset, data));
  original<FnMeshUpdateRegion>(kMeshUpdateVertexRegion)(self, mesh, surface, offset, data);
}

void hook_mesh_update_attribute_region(void *self, RID mesh, int surface, int offset,
                                       const Vector<uint8_t> *data) {
  bump(kMeshUpdateAttributeRegion);
  log_entry(&g_attribute_regions, region(mesh, surface, offset, data));
  original<FnMeshUpdateRegion>(kMeshUpdateAttributeRegion)(self, mesh, surface, offset, data);
}

void hook_mesh_clear(void *self, RID mesh) {
  bump(kMeshClear);
  log_entry(&g_mesh_clears, rids(mesh.id));
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
  original<FnMeshSetCustomAabb>(kMeshSetCustomAabb)(self, mesh, aabb);
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

enum class GeometryKind { kTriangleArray, kPrimitive, kPolyline };

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
  if (kind != GeometryKind::kPolyline) {
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
  if (kind == GeometryKind::kPolyline) {
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
  Log<PodEntry<ItemCustomRectKey>> set_custom_rects;
  Log<PodEntry<ItemColorKey>> set_self_modulates;
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
}

bool hooks_image_details_available() { return g_image_binds.available; }

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
  json.object_end();

  json.object_end();
  return json.take();
}

}  // namespace grc
