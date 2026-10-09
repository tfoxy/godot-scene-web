#include "hooks.h"

#include <atomic>
#include <cstring>
#include <mutex>

#include "abi.h"
#include "iface.h"
#include "report.h"

namespace grc {

namespace {

// Exact 4.5.1 signatures from servers/rendering_server.h, with the implicit
// `this` made explicit. A wrong signature would corrupt arguments, so each one
// names its source line.
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

struct Originals {
  void *add_rect = nullptr;
  void *add_texture_rect = nullptr;
  void *add_texture_rect_region = nullptr;
  void *add_msdf_texture_rect_region = nullptr;
  void *add_polygon = nullptr;
  void *texture_2d_create = nullptr;
  void *texture_2d_update = nullptr;
  void *free_rid = nullptr;
};

Originals g_originals;

struct Counters {
  std::atomic<uint64_t> add_rect{0};
  std::atomic<uint64_t> add_texture_rect{0};
  std::atomic<uint64_t> add_texture_rect_region{0};
  std::atomic<uint64_t> add_msdf_texture_rect_region{0};
  std::atomic<uint64_t> add_polygon{0};
  std::atomic<uint64_t> texture_2d_create{0};
  std::atomic<uint64_t> texture_2d_update{0};
  std::atomic<uint64_t> free_rid{0};
};

Counters g_counts;

std::atomic<uint64_t> g_frame{1};

constexpr size_t kMaxRects = 64;
constexpr size_t kMaxPolygons = 16;
constexpr size_t kMaxTextures = 32;
constexpr size_t kMaxPolygonPoints = 64;

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

std::mutex g_mutex;
std::vector<RectCapture> g_rects;
std::vector<PolygonCapture> g_polygons;
std::vector<ImageCapture> g_creates;
std::vector<ImageCapture> g_updates;

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
  ImageCapture out = {rid, g_frame.load(std::memory_order_relaxed), layer, false, -1, -1, -1, -1};
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

// --- the hooks ---------------------------------------------------------------

void hook_add_rect(void *self, RID item, const Rect2 *rect, const Color *color, bool antialiased) {
  g_counts.add_rect.fetch_add(1, std::memory_order_relaxed);
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
  reinterpret_cast<FnAddRect>(g_originals.add_rect)(self, item, rect, color, antialiased);
}

void hook_add_texture_rect(void *self, RID item, const Rect2 *rect, RID texture, bool tile,
                           const Color *modulate, bool transpose) {
  g_counts.add_texture_rect.fetch_add(1, std::memory_order_relaxed);
  reinterpret_cast<FnAddTextureRect>(g_originals.add_texture_rect)(self, item, rect, texture, tile,
                                                                  modulate, transpose);
}

void hook_add_texture_rect_region(void *self, RID item, const Rect2 *rect, RID texture,
                                  const Rect2 *source, const Color *modulate, bool transpose,
                                  bool clip_uv) {
  g_counts.add_texture_rect_region.fetch_add(1, std::memory_order_relaxed);
  reinterpret_cast<FnAddTextureRectRegion>(g_originals.add_texture_rect_region)(
      self, item, rect, texture, source, modulate, transpose, clip_uv);
}

void hook_add_msdf_texture_rect_region(void *self, RID item, const Rect2 *rect, RID texture,
                                       const Rect2 *source, const Color *modulate,
                                       int outline_size, float px_range, float scale) {
  g_counts.add_msdf_texture_rect_region.fetch_add(1, std::memory_order_relaxed);
  reinterpret_cast<FnAddMsdfTextureRectRegion>(g_originals.add_msdf_texture_rect_region)(
      self, item, rect, texture, source, modulate, outline_size, px_range, scale);
}

void hook_add_polygon(void *self, RID item, const Vector<Point2> *points,
                      const Vector<Color> *colors, const Vector<Point2> *uvs, RID texture) {
  g_counts.add_polygon.fetch_add(1, std::memory_order_relaxed);
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
  reinterpret_cast<FnAddPolygon>(g_originals.add_polygon)(self, item, points, colors, uvs, texture);
}

RID hook_texture_2d_create(void *self, const Ref *image) {
  g_counts.texture_2d_create.fetch_add(1, std::memory_order_relaxed);
  ImageCapture capture = describe_image(image, 0, -1);
  const RID result = reinterpret_cast<FnTexture2dCreate>(g_originals.texture_2d_create)(self, image);
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
  g_counts.texture_2d_update.fetch_add(1, std::memory_order_relaxed);
  {
    ImageCapture capture = describe_image(image, texture.id, layer);
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_updates.size() < kMaxTextures) {
      g_updates.push_back(capture);
    }
  }
  reinterpret_cast<FnTexture2dUpdate>(g_originals.texture_2d_update)(self, texture, image, layer);
}

void hook_free(void *self, RID rid) {
  g_counts.free_rid.fetch_add(1, std::memory_order_relaxed);
  reinterpret_cast<FnFree>(g_originals.free_rid)(self, rid);
}

struct HookSpec {
  const char *name;
  void *hook;
  void **original;
};

const HookSpec *hook_specs(size_t *count) {
  static const HookSpec specs[] = {
      {"canvas_item_add_rect", reinterpret_cast<void *>(&hook_add_rect), &g_originals.add_rect},
      {"canvas_item_add_texture_rect", reinterpret_cast<void *>(&hook_add_texture_rect),
       &g_originals.add_texture_rect},
      {"canvas_item_add_texture_rect_region",
       reinterpret_cast<void *>(&hook_add_texture_rect_region),
       &g_originals.add_texture_rect_region},
      {"canvas_item_add_msdf_texture_rect_region",
       reinterpret_cast<void *>(&hook_add_msdf_texture_rect_region),
       &g_originals.add_msdf_texture_rect_region},
      {"canvas_item_add_polygon", reinterpret_cast<void *>(&hook_add_polygon),
       &g_originals.add_polygon},
      {"texture_2d_create", reinterpret_cast<void *>(&hook_texture_2d_create),
       &g_originals.texture_2d_create},
      {"texture_2d_update", reinterpret_cast<void *>(&hook_texture_2d_update),
       &g_originals.texture_2d_update},
      {"free", reinterpret_cast<void *>(&hook_free), &g_originals.free_rid},
  };
  *count = sizeof(specs) / sizeof(specs[0]);
  return specs;
}

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

bool hooks_replacements(const Calibration &calib, std::vector<SlotReplacement> *out,
                        std::string *error) {
  size_t count = 0;
  const HookSpec *specs = hook_specs(&count);
  for (size_t i = 0; i < count; ++i) {
    const int64_t index = calib.slot(specs[i].name);
    if (index < 0) {
      *error = std::string("record does not name slot ") + specs[i].name;
      return false;
    }
    SlotReplacement replacement;
    replacement.index = static_cast<size_t>(index);
    replacement.hook = specs[i].hook;
    replacement.original_out = specs[i].original;
    out->push_back(replacement);
  }
  return true;
}

uint64_t hooks_total_calls() {
  return g_counts.add_rect.load() + g_counts.add_texture_rect.load() +
         g_counts.add_texture_rect_region.load() + g_counts.add_msdf_texture_rect_region.load() +
         g_counts.add_polygon.load() + g_counts.texture_2d_create.load() +
         g_counts.texture_2d_update.load() + g_counts.free_rid.load();
}

std::string hooks_counters_json(uint64_t frames_total, uint64_t frames_armed) {
  JsonWriter json;
  json.object_begin();
  json.field("schema", std::string("render-stream-gate-minus1-counters/1"));
  json.field("frames_total", static_cast<int64_t>(frames_total));
  json.field("frames_armed", static_cast<int64_t>(frames_armed));
  json.field("image_details_available", g_image_binds.available);

  json.key("counts").object_begin();
  json.field("canvas_item_add_rect", static_cast<int64_t>(g_counts.add_rect.load()));
  json.field("canvas_item_add_texture_rect",
             static_cast<int64_t>(g_counts.add_texture_rect.load()));
  json.field("canvas_item_add_texture_rect_region",
             static_cast<int64_t>(g_counts.add_texture_rect_region.load()));
  json.field("canvas_item_add_msdf_texture_rect_region",
             static_cast<int64_t>(g_counts.add_msdf_texture_rect_region.load()));
  json.field("canvas_item_add_polygon", static_cast<int64_t>(g_counts.add_polygon.load()));
  json.field("texture_2d_create", static_cast<int64_t>(g_counts.texture_2d_create.load()));
  json.field("texture_2d_update", static_cast<int64_t>(g_counts.texture_2d_update.load()));
  json.field("free", static_cast<int64_t>(g_counts.free_rid.load()));
  json.object_end();

  std::vector<RectCapture> rects;
  std::vector<PolygonCapture> polygons;
  std::vector<ImageCapture> creates;
  std::vector<ImageCapture> updates;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    rects = g_rects;
    polygons = g_polygons;
    creates = g_creates;
    updates = g_updates;
  }

  json.key("captured").object_begin();
  json.key("canvas_item_add_rect").array_begin();
  for (const RectCapture &capture : rects) {
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
  for (const PolygonCapture &capture : polygons) {
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
  write_image_captures(&json, creates, false);
  json.key("texture_2d_update");
  write_image_captures(&json, updates, true);
  json.object_end();

  json.object_end();
  return json.take();
}

}  // namespace grc
