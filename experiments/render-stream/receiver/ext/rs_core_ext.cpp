// RsCore: the native receiver's GDExtension adapter over the shared Rust core (gate7-design.md
// G7xn, Q14e, D34). C++ over the raw gdextension_interface.h (the capture extension's vendored
// copy, ../../capture/vendor), no godot-cpp.
//
// It registers one class, RsCore (RefCounted), whose methods receiver.gd reaches through
// Object.call() when RS_RECEIVER_CORE=rust (receiver/rs_rust_applier.gd). Each method hands its
// PackedByteArray/String/int arguments to rs-core-capi (rs_core_capi.h) by pointer, then:
//   - turns the core's Variant-tree answer (vt.rs) into the Dictionary/Array/String receiver.gd
//     reads, with ints as ints and keys in insertion order, and
//   - executes the core's RenderingServer call stream (ops.rs) as ptrcalls on the
//     RenderingServer singleton, in order. Every RID it creates goes into a per-kind table at the
//     handle the core chose; the core never sees a RID value.
// GDScript keeps configuration, I/O, evidence and shots.
//
// Nothing here interprets render-stream: the decode, validation, resolve and the applier's
// reconciliation are all the core's.

#include <chrono>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "gdextension_interface.h"
#include "rs_core_capi.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/em_js.h>
#endif

namespace {

// ------------------------------------------------------------------------------ interface

struct Gd {
  GDExtensionClassLibraryPtr library = nullptr;
  GDExtensionInterfaceGlobalGetSingleton global_get_singleton = nullptr;
  GDExtensionInterfaceClassdbGetMethodBind classdb_get_method_bind = nullptr;
  GDExtensionInterfaceObjectMethodBindPtrcall ptrcall = nullptr;
  GDExtensionInterfaceObjectDestroy object_destroy = nullptr;
  GDExtensionInterfaceObjectSetInstance object_set_instance = nullptr;
  GDExtensionInterfaceClassdbConstructObject2 construct_object = nullptr;
  GDExtensionInterfaceClassdbRegisterExtensionClass5 register_class = nullptr;
  GDExtensionInterfaceClassdbRegisterExtensionClassMethod register_method = nullptr;
  GDExtensionInterfaceClassdbUnregisterExtensionClass unregister_class = nullptr;
  GDExtensionInterfaceStringNameNewWithLatin1Chars string_name_latin1 = nullptr;
  GDExtensionInterfaceStringNameNewWithUtf8CharsAndLen string_name_utf8 = nullptr;
  GDExtensionInterfaceStringNewWithUtf8CharsAndLen2 string_utf8 = nullptr;
  GDExtensionInterfaceStringToUtf8Chars string_to_utf8 = nullptr;
  GDExtensionInterfaceVariantNewNil variant_new_nil = nullptr;
  GDExtensionInterfaceVariantNewCopy variant_new_copy = nullptr;
  GDExtensionInterfaceVariantDestroy variant_destroy = nullptr;
  GDExtensionInterfaceVariantGetType variant_get_type = nullptr;
  GDExtensionInterfaceGetVariantFromTypeConstructor get_from_type = nullptr;
  GDExtensionInterfaceGetVariantToTypeConstructor get_to_type = nullptr;
  GDExtensionInterfaceVariantGetPtrConstructor get_ptr_constructor = nullptr;
  GDExtensionInterfaceVariantGetPtrDestructor get_ptr_destructor = nullptr;
  GDExtensionInterfaceVariantGetPtrBuiltinMethod get_builtin_method = nullptr;
  GDExtensionInterfacePackedByteArrayOperatorIndex pba_index = nullptr;
  GDExtensionInterfacePackedByteArrayOperatorIndexConst pba_index_const = nullptr;
  GDExtensionInterfacePackedInt32ArrayOperatorIndex pi32_index = nullptr;
  GDExtensionInterfacePackedInt64ArrayOperatorIndex pi64_index = nullptr;
  GDExtensionInterfacePackedFloat32ArrayOperatorIndex pf32_index = nullptr;
  GDExtensionInterfacePackedFloat64ArrayOperatorIndex pf64_index = nullptr;
  GDExtensionInterfacePackedVector2ArrayOperatorIndex pv2_index = nullptr;
  GDExtensionInterfacePackedVector3ArrayOperatorIndex pv3_index = nullptr;
  GDExtensionInterfacePackedVector4ArrayOperatorIndex pv4_index = nullptr;
  GDExtensionInterfacePackedColorArrayOperatorIndex pcolor_index = nullptr;
  GDExtensionInterfaceDictionaryOperatorIndex dict_index = nullptr;

  GDExtensionVariantFromTypeConstructorFunc from[GDEXTENSION_VARIANT_TYPE_VARIANT_MAX] = {};
  GDExtensionTypeFromVariantConstructorFunc to[GDEXTENSION_VARIANT_TYPE_VARIANT_MAX] = {};
  GDExtensionPtrConstructor ctor[GDEXTENSION_VARIANT_TYPE_VARIANT_MAX] = {};
  GDExtensionPtrDestructor dtor[GDEXTENSION_VARIANT_TYPE_VARIANT_MAX] = {};
  GDExtensionPtrBuiltInMethod resize[GDEXTENSION_VARIANT_TYPE_VARIANT_MAX] = {};
  GDExtensionPtrBuiltInMethod pba_size = nullptr;
  GDExtensionPtrBuiltInMethod array_push_back = nullptr;
  GDExtensionPtrBuiltInMethod strings_push_back = nullptr;
};

Gd gd;
std::string g_missing;

template <typename T>
bool bind(GDExtensionInterfaceGetProcAddress get, const char *name, T *slot) {
  *slot = reinterpret_cast<T>(get(name));
  if (*slot == nullptr && g_missing.empty()) {
    g_missing = name;
  }
  return *slot != nullptr;
}

// Opaque engine values (sizes from extension_api.json, float_64).
struct alignas(8) Variant {
  uint8_t opaque[24];
};
struct alignas(8) Str {
  uint8_t opaque[8];
};
struct alignas(8) Packed {
  uint8_t opaque[16];
};

struct StringName {
  Str s{};
  bool valid = false;
  explicit StringName(const char *latin1) {
    gd.string_name_latin1(&s, latin1, false);
    valid = true;
  }
  StringName(const uint8_t *utf8, size_t len) {
    gd.string_name_utf8(&s, reinterpret_cast<const char *>(utf8), static_cast<GDExtensionInt>(len));
    valid = true;
  }
  ~StringName() {
    if (valid) gd.dtor[GDEXTENSION_VARIANT_TYPE_STRING_NAME](&s);
  }
  StringName(const StringName &) = delete;
  StringName &operator=(const StringName &) = delete;
  const void *ptr() const { return &s; }
};

struct String {
  Str s{};
  String(const uint8_t *utf8, size_t len) {
    gd.string_utf8(&s, reinterpret_cast<const char *>(utf8), static_cast<GDExtensionInt>(len));
  }
  explicit String(const std::string &t) : String(reinterpret_cast<const uint8_t *>(t.data()), t.size()) {}
  ~String() { gd.dtor[GDEXTENSION_VARIANT_TYPE_STRING](&s); }
  String(const String &) = delete;
  String &operator=(const String &) = delete;
};

// A packed array of `type`, owned.
struct PackedArray {
  Packed p{};
  GDExtensionVariantType type;
  explicit PackedArray(GDExtensionVariantType t) : type(t) { gd.ctor[t](&p, nullptr); }
  ~PackedArray() { gd.dtor[type](&p); }
  PackedArray(const PackedArray &) = delete;
  PackedArray &operator=(const PackedArray &) = delete;
  void resize(int64_t n) {
    int64_t ret = 0;
    const void *args[1] = {&n};
    gd.resize[type](&p, args, &ret, 1);
  }
  void *data() {
    switch (type) {
      case GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY:
        return gd.pba_index(&p, 0);
      case GDEXTENSION_VARIANT_TYPE_PACKED_INT32_ARRAY:
        return gd.pi32_index(&p, 0);
      case GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY:
        return gd.pi64_index(&p, 0);
      case GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT32_ARRAY:
        return gd.pf32_index(&p, 0);
      case GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT64_ARRAY:
        return gd.pf64_index(&p, 0);
      case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY:
        return gd.pv2_index(&p, 0);
      case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR3_ARRAY:
        return gd.pv3_index(&p, 0);
      case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR4_ARRAY:
        return gd.pv4_index(&p, 0);
      case GDEXTENSION_VARIANT_TYPE_PACKED_COLOR_ARRAY:
        return gd.pcolor_index(&p, 0);
      default:
        return nullptr;
    }
  }
  // Resizes to `bytes / element` elements and copies `bytes` in.
  void fill(const void *src, size_t bytes, size_t element) {
    resize(static_cast<int64_t>(bytes / element));
    if (bytes > 0) std::memcpy(data(), src, bytes);
  }
};

// ------------------------------------------------------------------------------ RenderingServer

enum Rs : int {
  RS_SET_DEFAULT_CLEAR_COLOR,
  RS_VIEWPORT_SET_CANVAS_TRANSFORM,
  RS_VIEWPORT_SET_CANVAS_CULL_MASK,
  RS_FREE_RID,
  RS_TEXTURE_2D_PLACEHOLDER_CREATE,
  RS_TEXTURE_REPLACE,
  RS_CANVAS_TEXTURE_CREATE,
  RS_CANVAS_TEXTURE_SET_CHANNEL,
  RS_CANVAS_TEXTURE_SET_TEXTURE_FILTER,
  RS_CANVAS_TEXTURE_SET_TEXTURE_REPEAT,
  RS_TEXTURE_2D_CREATE,
  RS_TEXTURE_2D_UPDATE,
  RS_MESH_CREATE,
  RS_MESH_CLEAR,
  RS_MESH_ADD_SURFACE,
  RS_MESH_SET_CUSTOM_AABB,
  RS_MESH_SURFACE_UPDATE_VERTEX_REGION,
  RS_MESH_SURFACE_UPDATE_ATTRIBUTE_REGION,
  RS_MESH_SURFACE_UPDATE_SKIN_REGION,
  RS_MESH_SURFACE_UPDATE_INDEX_REGION,
  RS_SHADER_CREATE,
  RS_SHADER_SET_CODE,
  RS_SHADER_SET_DEFAULT_TEXTURE_PARAMETER,
  RS_MATERIAL_CREATE,
  RS_MATERIAL_SET_SHADER,
  RS_MATERIAL_SET_PARAM,
  RS_CANVAS_CREATE,
  RS_VIEWPORT_ATTACH_CANVAS,
  RS_VIEWPORT_REMOVE_CANVAS,
  RS_VIEWPORT_SET_CANVAS_STACKING,
  RS_CANVAS_SET_MODULATE,
  RS_VIEWPORT_SET_DEFAULT_CANVAS_ITEM_TEXTURE_FILTER,
  RS_VIEWPORT_SET_DEFAULT_CANVAS_ITEM_TEXTURE_REPEAT,
  RS_CANVAS_ITEM_CREATE,
  RS_CANVAS_ITEM_SET_PARENT,
  RS_CANVAS_ITEM_SET_TRANSFORM,
  RS_CANVAS_ITEM_SET_MODULATE,
  RS_CANVAS_ITEM_SET_SELF_MODULATE,
  RS_CANVAS_ITEM_SET_VISIBLE,
  RS_CANVAS_ITEM_SET_CLIP,
  RS_CANVAS_ITEM_SET_CUSTOM_RECT,
  RS_CANVAS_ITEM_SET_VISIBILITY_LAYER,
  RS_CANVAS_ITEM_SET_Z_INDEX,
  RS_CANVAS_ITEM_SET_Z_AS_RELATIVE_TO_PARENT,
  RS_CANVAS_ITEM_SET_DRAW_BEHIND_PARENT,
  RS_CANVAS_ITEM_SET_DRAW_INDEX,
  RS_CANVAS_ITEM_SET_DEFAULT_TEXTURE_FILTER,
  RS_CANVAS_ITEM_SET_DEFAULT_TEXTURE_REPEAT,
  RS_CANVAS_ITEM_SET_MATERIAL,
  RS_CANVAS_ITEM_SET_USE_PARENT_MATERIAL,
  RS_CANVAS_ITEM_SET_INSTANCE_SHADER_PARAMETER,
  RS_CANVAS_ITEM_CLEAR,
  RS_CANVAS_ITEM_ADD_RECT,
  RS_CANVAS_ITEM_ADD_TEXTURE_RECT,
  RS_CANVAS_ITEM_ADD_TEXTURE_RECT_REGION,
  RS_CANVAS_ITEM_ADD_MSDF_TEXTURE_RECT_REGION,
  RS_CANVAS_ITEM_ADD_LINE,
  RS_CANVAS_ITEM_ADD_POLYLINE,
  RS_CANVAS_ITEM_ADD_MULTILINE,
  RS_CANVAS_ITEM_ADD_CIRCLE,
  RS_CANVAS_ITEM_ADD_PRIMITIVE,
  RS_CANVAS_ITEM_ADD_POLYGON,
  RS_CANVAS_ITEM_ADD_TRIANGLE_ARRAY,
  RS_CANVAS_ITEM_ADD_NINE_PATCH,
  RS_CANVAS_ITEM_ADD_SET_TRANSFORM,
  RS_CANVAS_ITEM_ADD_CLIP_IGNORE,
  RS_CANVAS_ITEM_ADD_MESH,
  RS_COUNT,
};

// Godot 4.5.1's method hashes (extension_api.json of the pinned 4.5.1 template).
struct RsBind {
  const char *name;
  int64_t hash;
};
constexpr RsBind RS_BINDS[RS_COUNT] = {
    {"set_default_clear_color", 2920490490},
    {"viewport_set_canvas_transform", 3608606053},
    {"viewport_set_canvas_cull_mask", 3411492887},
    {"free_rid", 2722037293},
    {"texture_2d_placeholder_create", 529393457},
    {"texture_replace", 395945892},
    {"canvas_texture_create", 529393457},
    {"canvas_texture_set_channel", 3822119138},
    {"canvas_texture_set_texture_filter", 1155129294},
    {"canvas_texture_set_texture_repeat", 1652956681},
    {"texture_2d_create", 2010018390},
    {"texture_2d_update", 999539803},
    {"mesh_create", 529393457},
    {"mesh_clear", 2722037293},
    {"mesh_add_surface", 1217542888},
    {"mesh_set_custom_aabb", 3696536120},
    {"mesh_surface_update_vertex_region", 2900195149},
    {"mesh_surface_update_attribute_region", 2900195149},
    {"mesh_surface_update_skin_region", 2900195149},
    {"mesh_surface_update_index_region", 2900195149},
    {"shader_create", 529393457},
    {"shader_set_code", 2726140452},
    {"shader_set_default_texture_parameter", 4094001817},
    {"material_create", 529393457},
    {"material_set_shader", 395945892},
    {"material_set_param", 3477296213},
    {"canvas_create", 529393457},
    {"viewport_attach_canvas", 395945892},
    {"viewport_remove_canvas", 395945892},
    {"viewport_set_canvas_stacking", 3713930247},
    {"canvas_set_modulate", 2948539648},
    {"viewport_set_default_canvas_item_texture_filter", 1155129294},
    {"viewport_set_default_canvas_item_texture_repeat", 1652956681},
    {"canvas_item_create", 529393457},
    {"canvas_item_set_parent", 395945892},
    {"canvas_item_set_transform", 1246044741},
    {"canvas_item_set_modulate", 2948539648},
    {"canvas_item_set_self_modulate", 2948539648},
    {"canvas_item_set_visible", 1265174801},
    {"canvas_item_set_clip", 1265174801},
    {"canvas_item_set_custom_rect", 1333997032},
    {"canvas_item_set_visibility_layer", 3411492887},
    {"canvas_item_set_z_index", 3411492887},
    {"canvas_item_set_z_as_relative_to_parent", 1265174801},
    {"canvas_item_set_draw_behind_parent", 1265174801},
    {"canvas_item_set_draw_index", 3411492887},
    {"canvas_item_set_default_texture_filter", 1155129294},
    {"canvas_item_set_default_texture_repeat", 1652956681},
    {"canvas_item_set_material", 395945892},
    {"canvas_item_set_use_parent_material", 1265174801},
    {"canvas_item_set_instance_shader_parameter", 3477296213},
    {"canvas_item_clear", 2722037293},
    {"canvas_item_add_rect", 3523446176},
    {"canvas_item_add_texture_rect", 324864032},
    {"canvas_item_add_texture_rect_region", 485157892},
    {"canvas_item_add_msdf_texture_rect_region", 97408773},
    {"canvas_item_add_line", 1819681853},
    {"canvas_item_add_polyline", 3098767073},
    {"canvas_item_add_multiline", 3098767073},
    {"canvas_item_add_circle", 333077949},
    {"canvas_item_add_primitive", 3731601077},
    {"canvas_item_add_polygon", 3580000528},
    {"canvas_item_add_triangle_array", 660261329},
    {"canvas_item_add_nine_patch", 389957886},
    {"canvas_item_add_set_transform", 1246044741},
    {"canvas_item_add_clip_ignore", 1265174801},
    {"canvas_item_add_mesh", 316450961},
};

struct Engine {
  bool ready = false;
  std::string error;
  GDExtensionObjectPtr rs = nullptr;
  GDExtensionMethodBindPtr binds[RS_COUNT] = {};
  GDExtensionMethodBindPtr image_create_from_data = nullptr;
  GDExtensionMethodBindPtr refcounted_unreference = nullptr;
  // G8ku: Image.load_ktx_from_buffer (D14: Godot's own KTX2 loader picks the transcode target)
  // and the getters the transcode log reads.
  GDExtensionMethodBindPtr image_load_ktx = nullptr;
  GDExtensionMethodBindPtr image_get_format = nullptr;
  GDExtensionMethodBindPtr image_get_width = nullptr;
  GDExtensionMethodBindPtr image_get_height = nullptr;
  GDExtensionMethodBindPtr image_has_mipmaps = nullptr;
  GDExtensionMethodBindPtr image_get_data = nullptr;
  GDExtensionMethodBindPtr image_get_data_size = nullptr;
};
Engine engine;

bool engine_ready() {
  if (engine.ready) return true;
  if (!engine.error.empty()) return false;
  StringName rs_name("RenderingServer");
  engine.rs = gd.global_get_singleton(rs_name.ptr());
  if (engine.rs == nullptr) {
    engine.error = "RenderingServer singleton unavailable";
    return false;
  }
  for (int i = 0; i < RS_COUNT; i++) {
    StringName method(RS_BINDS[i].name);
    engine.binds[i] = gd.classdb_get_method_bind(rs_name.ptr(), method.ptr(), RS_BINDS[i].hash);
    if (engine.binds[i] == nullptr) {
      engine.error = std::string("RenderingServer.") + RS_BINDS[i].name + " has another hash";
      return false;
    }
  }
  StringName image("Image"), create("create_from_data"), refcounted("RefCounted"), unref("unreference");
  engine.image_create_from_data = gd.classdb_get_method_bind(image.ptr(), create.ptr(), 299398494);
  engine.refcounted_unreference = gd.classdb_get_method_bind(refcounted.ptr(), unref.ptr(), 2240911060);
  if (engine.image_create_from_data == nullptr || engine.refcounted_unreference == nullptr) {
    engine.error = "Image.create_from_data or RefCounted.unreference has another hash";
    return false;
  }
  {
    StringName ktx("load_ktx_from_buffer"), fmt("get_format"), w("get_width"), h("get_height"),
        mips("has_mipmaps"), data("get_data"), size("get_data_size");
    engine.image_load_ktx = gd.classdb_get_method_bind(image.ptr(), ktx.ptr(), 680677267);
    engine.image_get_format = gd.classdb_get_method_bind(image.ptr(), fmt.ptr(), 3847873762);
    engine.image_get_width = gd.classdb_get_method_bind(image.ptr(), w.ptr(), 3905245786);
    engine.image_get_height = gd.classdb_get_method_bind(image.ptr(), h.ptr(), 3905245786);
    engine.image_has_mipmaps = gd.classdb_get_method_bind(image.ptr(), mips.ptr(), 36873697);
    engine.image_get_data = gd.classdb_get_method_bind(image.ptr(), data.ptr(), 2362200018);
    engine.image_get_data_size = gd.classdb_get_method_bind(image.ptr(), size.ptr(), 3905245786);
    if (engine.image_load_ktx == nullptr || engine.image_get_format == nullptr ||
        engine.image_get_width == nullptr || engine.image_get_height == nullptr ||
        engine.image_has_mipmaps == nullptr || engine.image_get_data == nullptr ||
        engine.image_get_data_size == nullptr) {
      engine.error = "an Image method G8ku's KTX2 path calls has another hash";
      return false;
    }
  }
  engine.ready = true;
  return true;
}

inline void rs_call(Rs which, std::initializer_list<const void *> args, void *ret = nullptr) {
  gd.ptrcall(engine.binds[which], engine.rs, args.size() ? args.begin() : nullptr, ret);
}

#ifdef __EMSCRIPTEN__
// The web export's index-region guard (G7xw; results/gate7/g7b.md Finding 2). Godot 4.5.1's
// mesh_surface_update_index_region binds the index buffer to GL_ARRAY_BUFFER
// (drivers/gles3/storage/mesh_storage.cpp:591-593), which WebGL 2 forbids for a buffer first bound
// as an element array buffer, so the engine's own update is dropped there. While the guard is
// installed (around that one RenderingServer call, which the nothreads web build runs
// synchronously), the engine's `glBindBuffer(GL_ARRAY_BUFFER, b)` binds `b` to
// GL_ELEMENT_ARRAY_BUFFER with no vertex array bound, its `glBufferSubData(GL_ARRAY_BUFFER, ...)`
// uploads there, and its closing `glBindBuffer(GL_ARRAY_BUFFER, 0)` unbinds the element array
// buffer, restores the vertex array that was bound and unbinds GL_ARRAY_BUFFER as the engine
// meant to. `GLctx` is the main module's WebGL 2 context: libdylink evaluates a side module's
// EM_JS bodies inside the main module's scope. `GLctx.rsIndexRegionUploads` counts the
// redirected uploads (a page-side diagnostic; gate 5's mesh legs are the evidence).
EM_JS(void, index_region_guard_begin, (), {
  var gl = GLctx;
  if (!gl || gl.rsIndexRegionGuard) return;
  var st = { bind: gl.bindBuffer, sub: gl.bufferSubData, buffer: null, vao: null };
  gl.rsIndexRegionGuard = st;
  gl.bindBuffer = function(target, buffer) {
    if (target !== gl.ARRAY_BUFFER) return st.bind.call(gl, target, buffer);
    if (buffer) {
      st.vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
      gl.bindVertexArray(null);
      st.buffer = buffer;
      st.bind.call(gl, gl.ELEMENT_ARRAY_BUFFER, buffer);
      return;
    }
    if (st.buffer) {
      st.bind.call(gl, gl.ELEMENT_ARRAY_BUFFER, null);
      gl.bindVertexArray(st.vao);
      st.buffer = null;
    }
    st.bind.call(gl, gl.ARRAY_BUFFER, null);
  };
  gl.bufferSubData = function(target) {
    var args = Array.prototype.slice.call(arguments);
    if (target === gl.ARRAY_BUFFER && st.buffer) {
      args[0] = gl.ELEMENT_ARRAY_BUFFER;
      gl.rsIndexRegionUploads = (gl.rsIndexRegionUploads || 0) + 1;
    }
    return st.sub.apply(gl, args);
  };
});

EM_JS(void, index_region_guard_end, (), {
  var gl = GLctx;
  var st = gl && gl.rsIndexRegionGuard;
  if (!st) return;
  if (st.buffer) {
    st.bind.call(gl, gl.ELEMENT_ARRAY_BUFFER, null);
    gl.bindVertexArray(st.vao);
  }
  gl.bindBuffer = st.bind;
  gl.bufferSubData = st.sub;
  delete gl.rsIndexRegionGuard;
});
#endif

// ------------------------------------------------------------------------------ the instance

struct Instance {
  RsCore *core = nullptr;
  uint64_t viewport = 0;
  uint64_t root_canvas = 0;
  std::vector<uint64_t> rids[6];
  // RIDs created/freed through the shim (diagnostics only).
  int64_t executed = 0;
  // G7o3: the last apply's split, in microseconds: the core's planner (rsc_apply), the op stream's
  // RenderingServer calls (execute) and the stats Variant tree (vt_variant).
  int64_t apply_plan_us = 0;
  int64_t apply_execute_us = 0;
  int64_t apply_stats_us = 0;
  // G8ku: one JSON object per KTX2 the executor transcoded since the last take_transcodes()
  // (texture-delivery-design.md D16 `transcode-oracle`); `hash_uploads` (set_transcode_log) adds
  // the uploaded blocks' SHA-256, off by default (it hashes every transcoded texture).
  std::string transcodes;
  bool hash_uploads = false;
  int64_t transcode_failed = 0;
  // G8kf: KTX2 files transcoded ahead of the apply (`pretranscode`), by the SHA-256 of their bytes;
  // the executor takes its image from here instead of transcoding again. A failure is thus known
  // before any RenderingServer call, and the receiver falls back to `decoded` (Q3).
  std::map<std::string, GDExtensionObjectPtr> pretranscoded;

  uint64_t &slot(uint32_t kind, uint32_t handle) {
    std::vector<uint64_t> &t = rids[kind];
    if (handle >= t.size()) t.resize(static_cast<size_t>(handle) + 1, 0);
    return t[handle];
  }
  uint64_t rid(uint32_t word) {
    uint32_t kind = word >> 29;
    uint32_t handle = word & ((1u << 29) - 1);
    if (kind == rsc::KIND_NONE) return 0;
    if (kind == rsc::KIND_SPECIAL) return handle == 0 ? viewport : root_canvas;
    return slot(kind, handle);
  }
};

// ------------------------------------------------------------------------------ Variant trees

struct VtReader {
  const uint8_t *b;
  size_t n;
  size_t at = 0;
  Instance *inst;
  bool bad = false;

  bool need(size_t k) {
    if (at + k > n) {
      bad = true;
      return false;
    }
    return true;
  }
  uint8_t u8() { return need(1) ? b[at++] : 0; }
  uint32_t u32() {
    if (!need(4)) return 0;
    uint32_t v;
    std::memcpy(&v, b + at, 4);
    at += 4;
    return v;
  }
  int64_t i64() {
    if (!need(8)) return 0;
    int64_t v;
    std::memcpy(&v, b + at, 8);
    at += 8;
    return v;
  }
  double f64() {
    if (!need(8)) return 0;
    double v;
    std::memcpy(&v, b + at, 8);
    at += 8;
    return v;
  }
  // A length-prefixed UTF-8 run: (pointer, length).
  std::pair<const uint8_t *, size_t> raw() {
    uint32_t len = u32();
    if (!need(len)) return {b, 0};
    const uint8_t *p = b + at;
    at += len;
    return {p, len};
  }

  // Reads one value into `out` (uninitialized storage).
  void read(Variant *out) {
    uint8_t tag = u8();
    if (bad) {
      gd.variant_new_nil(out);
      return;
    }
    switch (tag) {
      case rsc::T_NIL:
        gd.variant_new_nil(out);
        return;
      case rsc::T_BOOL: {
        GDExtensionBool v = u8() != 0;
        gd.from[GDEXTENSION_VARIANT_TYPE_BOOL](out, &v);
        return;
      }
      case rsc::T_INT: {
        int64_t v = i64();
        gd.from[GDEXTENSION_VARIANT_TYPE_INT](out, &v);
        return;
      }
      case rsc::T_FLOAT: {
        double v = f64();
        gd.from[GDEXTENSION_VARIANT_TYPE_FLOAT](out, &v);
        return;
      }
      case rsc::T_STRING: {
        auto [p, len] = raw();
        String s(p, len);
        gd.from[GDEXTENSION_VARIANT_TYPE_STRING](out, &s.s);
        return;
      }
      case rsc::T_ARRAY: {
        uint32_t count = u32();
        Str arr{};
        gd.ctor[GDEXTENSION_VARIANT_TYPE_ARRAY](&arr, nullptr);
        for (uint32_t i = 0; i < count && !bad; i++) {
          Variant v;
          read(&v);
          const void *args[1] = {&v};
          gd.array_push_back(&arr, args, nullptr, 1);
          gd.variant_destroy(&v);
        }
        gd.from[GDEXTENSION_VARIANT_TYPE_ARRAY](out, &arr);
        gd.dtor[GDEXTENSION_VARIANT_TYPE_ARRAY](&arr);
        return;
      }
      case rsc::T_DICT: {
        uint32_t count = u32();
        Str dict{};
        gd.ctor[GDEXTENSION_VARIANT_TYPE_DICTIONARY](&dict, nullptr);
        for (uint32_t i = 0; i < count && !bad; i++) {
          auto [p, len] = raw();
          Variant key;
          {
            String k(p, len);
            gd.from[GDEXTENSION_VARIANT_TYPE_STRING](&key, &k.s);
          }
          Variant value;
          read(&value);
          GDExtensionVariantPtr slot = gd.dict_index(&dict, &key);
          gd.variant_destroy(slot);
          gd.variant_new_copy(slot, &value);
          gd.variant_destroy(&value);
          gd.variant_destroy(&key);
        }
        gd.from[GDEXTENSION_VARIANT_TYPE_DICTIONARY](out, &dict);
        gd.dtor[GDEXTENSION_VARIANT_TYPE_DICTIONARY](&dict);
        return;
      }
      case rsc::T_MATH: {
        auto type = static_cast<GDExtensionVariantType>(u8());
        uint8_t count = u8();
        bool ints = type == GDEXTENSION_VARIANT_TYPE_VECTOR2I || type == GDEXTENSION_VARIANT_TYPE_RECT2I ||
                    type == GDEXTENSION_VARIANT_TYPE_VECTOR3I || type == GDEXTENSION_VARIANT_TYPE_VECTOR4I;
        alignas(8) uint8_t buf[16 * 8] = {};
        for (uint8_t i = 0; i < count && i < 16; i++) {
          if (ints) {
            int32_t v = static_cast<int32_t>(i64());
            std::memcpy(buf + 4 * i, &v, 4);
          } else {
            float v = static_cast<float>(f64());
            std::memcpy(buf + 4 * i, &v, 4);
          }
        }
        if (bad || type >= GDEXTENSION_VARIANT_TYPE_VARIANT_MAX || gd.from[type] == nullptr) {
          bad = true;
          gd.variant_new_nil(out);
          return;
        }
        gd.from[type](out, buf);
        return;
      }
      case rsc::T_PACKED: {
        auto type = static_cast<GDExtensionVariantType>(u8());
        uint32_t count = u32();
        size_t comps = 1;
        bool ints = false, wide = false;
        switch (type) {
          case GDEXTENSION_VARIANT_TYPE_PACKED_INT32_ARRAY:
            ints = true;
            break;
          case GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY:
            ints = true;
            wide = true;
            break;
          case GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT32_ARRAY:
            break;
          case GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT64_ARRAY:
            wide = true;
            break;
          case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY:
            comps = 2;
            break;
          case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR3_ARRAY:
            comps = 3;
            break;
          case GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR4_ARRAY:
          case GDEXTENSION_VARIANT_TYPE_PACKED_COLOR_ARRAY:
            comps = 4;
            break;
          default:
            bad = true;
            gd.variant_new_nil(out);
            return;
        }
        PackedArray arr(type);
        arr.resize(count);
        uint8_t *dst = static_cast<uint8_t *>(count ? arr.data() : nullptr);
        for (size_t i = 0; i < count * comps && !bad; i++) {
          if (ints && wide) {
            int64_t v = i64();
            std::memcpy(dst + 8 * i, &v, 8);
          } else if (ints) {
            int32_t v = static_cast<int32_t>(i64());
            std::memcpy(dst + 4 * i, &v, 4);
          } else if (wide) {
            double v = f64();
            std::memcpy(dst + 8 * i, &v, 8);
          } else {
            float v = static_cast<float>(f64());
            std::memcpy(dst + 4 * i, &v, 4);
          }
        }
        gd.from[type](out, &arr.p);
        return;
      }
      case rsc::T_RID: {
        uint64_t r = inst->rid(u32());
        gd.from[GDEXTENSION_VARIANT_TYPE_RID](out, &r);
        return;
      }
      case rsc::T_PACKED_STRINGS: {
        uint32_t count = u32();
        PackedArray arr(GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY);
        for (uint32_t i = 0; i < count && !bad; i++) {
          auto [p, len] = raw();
          String s(p, len);
          const void *args[1] = {&s.s};
          GDExtensionBool ok = false;
          gd.strings_push_back(&arr.p, args, &ok, 1);
        }
        gd.from[GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY](out, &arr.p);
        return;
      }
      default:
        bad = true;
        gd.variant_new_nil(out);
        return;
    }
  }
};

void vt_variant(Instance *inst, Variant *out) {
  size_t n = 0;
  const uint8_t *b = rsc_vt(inst->core, &n);
  VtReader r{b, n, 0, inst};
  r.read(out);
}

void text_string(Instance *inst, Variant *out) {
  size_t n = 0;
  const uint8_t *b = rsc_text(inst->core, &n);
  String s(b, n);
  gd.from[GDEXTENSION_VARIANT_TYPE_STRING](out, &s.s);
}

void text_bytes(Instance *inst, Variant *out) {
  size_t n = 0;
  const uint8_t *b = rsc_text(inst->core, &n);
  PackedArray arr(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
  arr.fill(b, n, 1);
  gd.from[GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY](out, &arr.p);
}

// ------------------------------------------------------------------------------ the op stream

struct OpReader {
  const uint32_t *w;
  size_t n;
  size_t at = 0;
  const uint8_t *arena;
  size_t arena_n;
  Instance *inst;

  uint32_t u() { return at < n ? w[at++] : 0; }
  int64_t i64() {
    uint64_t lo = u();
    uint64_t hi = u();
    return static_cast<int64_t>(lo | (hi << 32));
  }
  float f() {
    uint32_t bits = u();
    float v;
    std::memcpy(&v, &bits, 4);
    return v;
  }
  double fd() { return static_cast<double>(f()); }
  GDExtensionBool b() { return u() != 0; }
  uint64_t rid() { return inst->rid(u()); }
  void fs(float *out, int k) {
    for (int i = 0; i < k; i++) out[i] = f();
  }
  std::pair<const uint8_t *, size_t> bytes() {
    uint32_t off = u();
    uint32_t len = u();
    if (static_cast<size_t>(off) + len > arena_n) return {arena, 0};
    return {arena + off, len};
  }
  // A length-prefixed float array of `per`-float elements into a packed array.
  void farray(PackedArray &arr, int per) {
    uint32_t count = u();
    size_t floats = static_cast<size_t>(count) * per;
    arr.resize(count);
    if (count) {
      float *dst = static_cast<float *>(arr.data());
      for (size_t i = 0; i < floats; i++) dst[i] = f();
    }
  }
  void iarray(PackedArray &arr) {
    uint32_t count = u();
    arr.resize(count);
    if (count) {
      int32_t *dst = static_cast<int32_t *>(arr.data());
      for (size_t i = 0; i < count; i++) dst[i] = static_cast<int32_t>(u());
    }
  }
};

// Image.create_from_data(w, h, mipmaps, format, data) as an owned Object* (nullptr for a format
// the core did not code: -1, i.e. none of the six 8-bit formats and, from /8, the eight float
// formats RF RGF RGBF RGBAF RH RGH RGBH RGBAH, whose Image.Format values 8-15 the core sends as is
// (G8f, gate8-design.md D9). The engine's own GLES3 upload then applies its float rules: 32-bit
// floats become halves where OES_texture_float_linear is missing.)
GDExtensionObjectPtr make_image(OpReader &r, Instance *inst);

// G8ku (texture-delivery-design.md Q6 "Native receiver", D14): a `uastc` variant's KTX2 file
// (rs-core verified its hash and checked its shape) through Image.load_ktx_from_buffer, which
// transcodes to the first target Godot's KTX2 loader finds in RenderingServer.has_os_feature
// (with 4 channels ASTC_4x4, BC7, BC3, ETC2_RGBA, then RGBA8). The transcode is logged.
GDExtensionObjectPtr transcode_ktx2(const uint8_t *p, size_t len, int64_t width, int64_t height,
                                    Instance *inst) {
  StringName image_class("Image");
  GDExtensionObjectPtr image = gd.construct_object(image_class.ptr());
  PackedArray data(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
  data.fill(p, len, 1);
  int64_t error = 0;
  const void *args[1] = {&data.p};
  const auto t0 = std::chrono::steady_clock::now();
  gd.ptrcall(engine.image_load_ktx, image, args, &error);
  const int64_t us = std::chrono::duration_cast<std::chrono::microseconds>(
                         std::chrono::steady_clock::now() - t0)
                         .count();
  char hash[65] = {0};
  rsc_sha256_hex(p, len, reinterpret_cast<uint8_t *>(hash));
  int64_t format = -1, w = 0, h = 0, data_size = 0;
  GDExtensionBool mips = false;
  if (error == 0) {
    gd.ptrcall(engine.image_get_format, image, nullptr, &format);
    gd.ptrcall(engine.image_get_width, image, nullptr, &w);
    gd.ptrcall(engine.image_get_height, image, nullptr, &h);
    gd.ptrcall(engine.image_has_mipmaps, image, nullptr, &mips);
    gd.ptrcall(engine.image_get_data_size, image, nullptr, &data_size);
  }
  std::string row = std::string("{\"hash\":\"") + hash + "\",\"ok\":" +
                    (error == 0 && (width < 0 || (w == width && h == height)) ? "true" : "false") +
                    ",\"error\":" + std::to_string(error) + ",\"format\":" + std::to_string(format) +
                    ",\"width\":" + std::to_string(w) + ",\"height\":" + std::to_string(h) +
                    ",\"mipmaps\":" + (mips ? "true" : "false") +
                    ",\"data_bytes\":" + std::to_string(data_size) +
                    ",\"ktx2_bytes\":" + std::to_string(len) + ",\"transcode_us\":" + std::to_string(us);
  if (error == 0 && inst->hash_uploads) {
    PackedArray out(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
    gd.ptrcall(engine.image_get_data, image, nullptr, &out.p);
    char digest[65] = {0};
    rsc_sha256_hex(data_size > 0 ? static_cast<const uint8_t *>(out.data()) : nullptr,
                   static_cast<size_t>(data_size), reinterpret_cast<uint8_t *>(digest));
    row += std::string(",\"data_sha256\":\"") + digest + "\"";
  }
  row += "}";
  inst->transcodes += (inst->transcodes.empty() ? "" : ",") + row;
  if (error != 0 || (width >= 0 && (w != width || h != height))) {
    ++inst->transcode_failed;
    GDExtensionBool last = false;
    gd.ptrcall(engine.refcounted_unreference, image, nullptr, &last);
    if (last) gd.object_destroy(image);
    return nullptr;
  }
  return image;
}


void release_image(GDExtensionObjectPtr image);

// The executor's KTX2 image: the pre-transcoded one when `pretranscode` already ran this file,
// else the transcode now. Dimensions are the entry's (the core checked the header against them).
GDExtensionObjectPtr make_ktx2_image(const uint8_t *p, size_t len, int64_t width, int64_t height,
                                     Instance *inst) {
  if (!inst->pretranscoded.empty()) {
    char hash[65] = {0};
    rsc_sha256_hex(p, len, reinterpret_cast<uint8_t *>(hash));
    auto it = inst->pretranscoded.find(hash);
    if (it != inst->pretranscoded.end()) {
      GDExtensionObjectPtr image = it->second;
      inst->pretranscoded.erase(it);
      int64_t w = 0, h = 0;
      gd.ptrcall(engine.image_get_width, image, nullptr, &w);
      gd.ptrcall(engine.image_get_height, image, nullptr, &h);
      if (w != width || h != height) {
        ++inst->transcode_failed;
        release_image(image);
        return nullptr;
      }
      return image;
    }
  }
  return transcode_ktx2(p, len, width, height, inst);
}

// G8kf: transcodes a KTX2 now and keeps the image for the executor. True when it transcoded (or
// already had); the row is logged either way.
bool pretranscode_ktx2(const uint8_t *p, size_t len, Instance *inst) {
  char hash[65] = {0};
  rsc_sha256_hex(p, len, reinterpret_cast<uint8_t *>(hash));
  if (inst->pretranscoded.count(hash) != 0) return true;
  GDExtensionObjectPtr image = transcode_ktx2(p, len, -1, -1, inst);
  if (image == nullptr) return false;
  inst->pretranscoded[hash] = image;
  return true;
}

void release_pretranscoded(Instance *inst) {
  for (auto &entry : inst->pretranscoded) release_image(entry.second);
  inst->pretranscoded.clear();
}

GDExtensionObjectPtr make_image(OpReader &r, Instance *inst) {
  int64_t format = static_cast<int32_t>(r.u());
  int64_t width = r.i64();
  int64_t height = r.i64();
  GDExtensionBool mipmaps = r.b();
  auto [p, len] = r.bytes();
  if (format == rsc::KTX2_FORMAT) return make_ktx2_image(p, len, width, height, inst);
  if (format < 0) return nullptr;
  PackedArray data(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
  data.fill(p, len, 1);
  GDExtensionObjectPtr image = nullptr;
  const void *args[5] = {&width, &height, &mipmaps, &format, &data.p};
  gd.ptrcall(engine.image_create_from_data, nullptr, args, &image);
  return image;
}

void release_image(GDExtensionObjectPtr image) {
  if (image == nullptr) return;
  GDExtensionBool last = false;
  gd.ptrcall(engine.refcounted_unreference, image, nullptr, &last);
  if (last) gd.object_destroy(image);
}

void variant_from_bytes(Instance *inst, std::pair<const uint8_t *, size_t> b, Variant *out) {
  VtReader v{b.first, b.second, 0, inst};
  v.read(out);
}

// Executes the core's current op stream. Returns the number of ops.
int64_t execute(Instance *inst) {
  size_t nw = 0, na = 0;
  const uint32_t *w = rsc_ops_words(inst->core, &nw);
  const uint8_t *arena = rsc_ops_arena(inst->core, &na);
  OpReader r{w, nw, 0, arena, na, inst};
  int64_t ops = 0;
  while (r.at < nw) {
    uint32_t op = r.u();
    ops++;
    switch (op) {
      case rsc::SetDefaultClearColor: {
        float c[4];
        r.fs(c, 4);
        rs_call(RS_SET_DEFAULT_CLEAR_COLOR, {c});
        break;
      }
      case rsc::ViewportSetCanvasTransform: {
        uint64_t canvas = r.rid();
        float x[6];
        r.fs(x, 6);
        rs_call(RS_VIEWPORT_SET_CANVAS_TRANSFORM, {&inst->viewport, &canvas, x});
        break;
      }
      case rsc::ViewportSetCanvasCullMask: {
        int64_t mask = r.i64();
        rs_call(RS_VIEWPORT_SET_CANVAS_CULL_MASK, {&inst->viewport, &mask});
        break;
      }
      case rsc::FreeRid: {
        uint32_t word = r.u();
        uint64_t rid = inst->rid(word);
        rs_call(RS_FREE_RID, {&rid});
        uint32_t kind = word >> 29;
        if (kind < 6) inst->slot(kind, word & ((1u << 29) - 1)) = 0;
        break;
      }
      case rsc::Texture2dPlaceholderCreate: {
        uint32_t h = r.u();
        uint64_t rid = 0;
        rs_call(RS_TEXTURE_2D_PLACEHOLDER_CREATE, {}, &rid);
        inst->slot(rsc::KIND_TEXTURE, h) = rid;
        break;
      }
      case rsc::TextureReplaceWithPlaceholder: {
        uint64_t tex = r.rid();
        uint64_t placeholder = 0;
        rs_call(RS_TEXTURE_2D_PLACEHOLDER_CREATE, {}, &placeholder);
        rs_call(RS_TEXTURE_REPLACE, {&tex, &placeholder});
        break;
      }
      case rsc::CanvasTextureCreate: {
        uint32_t h = r.u();
        uint64_t rid = 0;
        rs_call(RS_CANVAS_TEXTURE_CREATE, {}, &rid);
        inst->slot(rsc::KIND_TEXTURE, h) = rid;
        break;
      }
      case rsc::CanvasTextureSetChannel: {
        uint64_t tex = r.rid();
        int64_t channel = r.u();
        uint64_t diffuse = r.rid();
        rs_call(RS_CANVAS_TEXTURE_SET_CHANNEL, {&tex, &channel, &diffuse});
        break;
      }
      case rsc::CanvasTextureSetFilter: {
        uint64_t tex = r.rid();
        int64_t v = r.u();
        rs_call(RS_CANVAS_TEXTURE_SET_TEXTURE_FILTER, {&tex, &v});
        break;
      }
      case rsc::CanvasTextureSetRepeat: {
        uint64_t tex = r.rid();
        int64_t v = r.u();
        rs_call(RS_CANVAS_TEXTURE_SET_TEXTURE_REPEAT, {&tex, &v});
        break;
      }
      case rsc::Texture2dCreate: {
        uint32_t h = r.u();
        GDExtensionObjectPtr image = make_image(r, inst);
        uint64_t rid = 0;
        rs_call(RS_TEXTURE_2D_CREATE, {&image}, &rid);
        release_image(image);
        inst->slot(rsc::KIND_TEXTURE, h) = rid;
        break;
      }
      case rsc::Texture2dUpdate: {
        uint64_t tex = r.rid();
        GDExtensionObjectPtr image = make_image(r, inst);
        int64_t layer = 0;
        rs_call(RS_TEXTURE_2D_UPDATE, {&tex, &image, &layer});
        release_image(image);
        break;
      }
      case rsc::TextureReplaceWithImage: {
        uint64_t tex = r.rid();
        GDExtensionObjectPtr image = make_image(r, inst);
        uint64_t replacement = 0;
        rs_call(RS_TEXTURE_2D_CREATE, {&image}, &replacement);
        release_image(image);
        rs_call(RS_TEXTURE_REPLACE, {&tex, &replacement});
        break;
      }
      case rsc::MeshCreate: {
        uint32_t h = r.u();
        uint64_t rid = 0;
        rs_call(RS_MESH_CREATE, {}, &rid);
        inst->slot(rsc::KIND_MESH, h) = rid;
        break;
      }
      case rsc::MeshClear: {
        uint64_t mesh = r.rid();
        rs_call(RS_MESH_CLEAR, {&mesh});
        break;
      }
      case rsc::MeshAddSurface: {
        uint64_t mesh = r.rid();
        int64_t primitive = r.u();
        int64_t format = r.i64();
        int64_t vertex_count = r.i64();
        int64_t index_count = r.i64();
        float aabb[6], uv[4];
        r.fs(aabb, 6);
        r.fs(uv, 4);
        std::pair<const uint8_t *, size_t> bufs[4];
        for (auto &b : bufs) b = r.bytes();
        Str dict{};
        gd.ctor[GDEXTENSION_VARIANT_TYPE_DICTIONARY](&dict, nullptr);
        auto put = [&](const char *key, Variant *value) {
          Variant k;
          {
            String ks(reinterpret_cast<const uint8_t *>(key), std::strlen(key));
            gd.from[GDEXTENSION_VARIANT_TYPE_STRING](&k, &ks.s);
          }
          GDExtensionVariantPtr slot = gd.dict_index(&dict, &k);
          gd.variant_destroy(slot);
          gd.variant_new_copy(slot, value);
          gd.variant_destroy(value);
          gd.variant_destroy(&k);
        };
        auto put_int = [&](const char *key, int64_t v) {
          Variant x;
          gd.from[GDEXTENSION_VARIANT_TYPE_INT](&x, &v);
          put(key, &x);
        };
        auto put_bytes = [&](const char *key, std::pair<const uint8_t *, size_t> b) {
          PackedArray a(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
          a.fill(b.first, b.second, 1);
          Variant x;
          gd.from[GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY](&x, &a.p);
          put(key, &x);
        };
        put_int("primitive", primitive);
        put_int("format", format);
        put_bytes("vertex_data", bufs[0]);
        put_bytes("attribute_data", bufs[1]);
        put_bytes("skin_data", bufs[2]);
        put_int("vertex_count", vertex_count);
        {
          Variant x;
          gd.from[GDEXTENSION_VARIANT_TYPE_AABB](&x, aabb);
          put("aabb", &x);
        }
        {
          Variant x;
          gd.from[GDEXTENSION_VARIANT_TYPE_VECTOR4](&x, uv);
          put("uv_scale", &x);
        }
        if (index_count > 0) {
          put_bytes("index_data", bufs[3]);
          put_int("index_count", index_count);
        }
        rs_call(RS_MESH_ADD_SURFACE, {&mesh, &dict});
        gd.dtor[GDEXTENSION_VARIANT_TYPE_DICTIONARY](&dict);
        break;
      }
      case rsc::MeshSetCustomAabb: {
        uint64_t mesh = r.rid();
        float aabb[6];
        r.fs(aabb, 6);
        rs_call(RS_MESH_SET_CUSTOM_AABB, {&mesh, aabb});
        break;
      }
      case rsc::MeshSurfaceUpdateRegion: {
        uint64_t mesh = r.rid();
        uint32_t which = r.u();
        int64_t surface = r.u();
        auto b = r.bytes();
        PackedArray data(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY);
        data.fill(b.first, b.second, 1);
        int64_t offset = 0;
        Rs fn = which == 0   ? RS_MESH_SURFACE_UPDATE_VERTEX_REGION
                : which == 1 ? RS_MESH_SURFACE_UPDATE_ATTRIBUTE_REGION
                : which == 2 ? RS_MESH_SURFACE_UPDATE_SKIN_REGION
                             : RS_MESH_SURFACE_UPDATE_INDEX_REGION;
#ifdef __EMSCRIPTEN__
        // Web export (G7xw): see index_region_guard_begin().
        if (fn == RS_MESH_SURFACE_UPDATE_INDEX_REGION) {
          index_region_guard_begin();
          rs_call(fn, {&mesh, &surface, &offset, &data.p});
          index_region_guard_end();
          break;
        }
#endif
        rs_call(fn, {&mesh, &surface, &offset, &data.p});
        break;
      }
      case rsc::ShaderCreate: {
        uint32_t h = r.u();
        uint64_t rid = 0;
        rs_call(RS_SHADER_CREATE, {}, &rid);
        inst->slot(rsc::KIND_SHADER, h) = rid;
        break;
      }
      case rsc::ShaderSetCode: {
        uint64_t shader = r.rid();
        auto b = r.bytes();
        String code(b.first, b.second);
        rs_call(RS_SHADER_SET_CODE, {&shader, &code.s});
        break;
      }
      case rsc::ShaderSetDefaultTexture: {
        uint64_t shader = r.rid();
        auto name = r.bytes();
        uint64_t tex = r.rid();
        int64_t index = r.i64();
        StringName sn(name.first, name.second);
        rs_call(RS_SHADER_SET_DEFAULT_TEXTURE_PARAMETER, {&shader, sn.ptr(), &tex, &index});
        break;
      }
      case rsc::MaterialCreate: {
        uint32_t h = r.u();
        uint64_t rid = 0;
        rs_call(RS_MATERIAL_CREATE, {}, &rid);
        inst->slot(rsc::KIND_MATERIAL, h) = rid;
        break;
      }
      case rsc::MaterialSetShader: {
        uint64_t material = r.rid();
        uint64_t shader = r.rid();
        rs_call(RS_MATERIAL_SET_SHADER, {&material, &shader});
        break;
      }
      case rsc::MaterialSetParam:
      case rsc::ItemSetInstanceParam: {
        uint64_t target = r.rid();
        auto name = r.bytes();
        auto value = r.bytes();
        StringName sn(name.first, name.second);
        Variant v;
        variant_from_bytes(inst, value, &v);
        rs_call(op == rsc::MaterialSetParam ? RS_MATERIAL_SET_PARAM : RS_CANVAS_ITEM_SET_INSTANCE_SHADER_PARAMETER,
                {&target, sn.ptr(), &v});
        gd.variant_destroy(&v);
        break;
      }
      case rsc::CanvasCreate: {
        uint32_t h = r.u();
        uint64_t rid = 0;
        rs_call(RS_CANVAS_CREATE, {}, &rid);
        inst->slot(rsc::KIND_CANVAS, h) = rid;
        break;
      }
      case rsc::ViewportAttachCanvas: {
        uint64_t canvas = r.rid();
        rs_call(RS_VIEWPORT_ATTACH_CANVAS, {&inst->viewport, &canvas});
        break;
      }
      case rsc::ViewportRemoveCanvas: {
        uint64_t canvas = r.rid();
        rs_call(RS_VIEWPORT_REMOVE_CANVAS, {&inst->viewport, &canvas});
        break;
      }
      case rsc::ViewportSetCanvasStacking: {
        uint64_t canvas = r.rid();
        int64_t layer = r.i64();
        int64_t sublayer = r.i64();
        rs_call(RS_VIEWPORT_SET_CANVAS_STACKING, {&inst->viewport, &canvas, &layer, &sublayer});
        break;
      }
      case rsc::CanvasSetModulate: {
        uint64_t canvas = r.rid();
        float c[4];
        r.fs(c, 4);
        rs_call(RS_CANVAS_SET_MODULATE, {&canvas, c});
        break;
      }
      case rsc::ViewportSetDefaultFilter: {
        int64_t v = r.u();
        rs_call(RS_VIEWPORT_SET_DEFAULT_CANVAS_ITEM_TEXTURE_FILTER, {&inst->viewport, &v});
        break;
      }
      case rsc::ViewportSetDefaultRepeat: {
        int64_t v = r.u();
        rs_call(RS_VIEWPORT_SET_DEFAULT_CANVAS_ITEM_TEXTURE_REPEAT, {&inst->viewport, &v});
        break;
      }
      case rsc::CanvasItemCreate: {
        uint32_t h = r.u();
        uint64_t rid = 0;
        rs_call(RS_CANVAS_ITEM_CREATE, {}, &rid);
        inst->slot(rsc::KIND_ITEM, h) = rid;
        break;
      }
      case rsc::ItemSetParent: {
        uint64_t item = r.rid();
        uint64_t parent = r.rid();
        rs_call(RS_CANVAS_ITEM_SET_PARENT, {&item, &parent});
        break;
      }
      case rsc::ItemSetTransform:
      case rsc::AddSetTransform: {
        uint64_t item = r.rid();
        float x[6];
        r.fs(x, 6);
        rs_call(op == rsc::ItemSetTransform ? RS_CANVAS_ITEM_SET_TRANSFORM : RS_CANVAS_ITEM_ADD_SET_TRANSFORM,
                {&item, x});
        break;
      }
      case rsc::ItemSetModulate:
      case rsc::ItemSetSelfModulate: {
        uint64_t item = r.rid();
        float c[4];
        r.fs(c, 4);
        rs_call(op == rsc::ItemSetModulate ? RS_CANVAS_ITEM_SET_MODULATE : RS_CANVAS_ITEM_SET_SELF_MODULATE,
                {&item, c});
        break;
      }
      case rsc::ItemSetVisible:
      case rsc::ItemSetClip:
      case rsc::ItemSetZRelative:
      case rsc::ItemSetDrawBehindParent:
      case rsc::ItemSetUseParentMaterial:
      case rsc::AddClipIgnore: {
        uint64_t item = r.rid();
        GDExtensionBool v = r.b();
        Rs fn = op == rsc::ItemSetVisible            ? RS_CANVAS_ITEM_SET_VISIBLE
                : op == rsc::ItemSetClip             ? RS_CANVAS_ITEM_SET_CLIP
                : op == rsc::ItemSetZRelative        ? RS_CANVAS_ITEM_SET_Z_AS_RELATIVE_TO_PARENT
                : op == rsc::ItemSetDrawBehindParent ? RS_CANVAS_ITEM_SET_DRAW_BEHIND_PARENT
                : op == rsc::ItemSetUseParentMaterial ? RS_CANVAS_ITEM_SET_USE_PARENT_MATERIAL
                                                      : RS_CANVAS_ITEM_ADD_CLIP_IGNORE;
        rs_call(fn, {&item, &v});
        break;
      }
      case rsc::ItemSetCustomRect: {
        uint64_t item = r.rid();
        GDExtensionBool use = r.b();
        float rect[4];
        r.fs(rect, 4);
        rs_call(RS_CANVAS_ITEM_SET_CUSTOM_RECT, {&item, &use, rect});
        break;
      }
      case rsc::ItemSetVisibilityLayer:
      case rsc::ItemSetZIndex:
      case rsc::ItemSetDrawIndex: {
        uint64_t item = r.rid();
        int64_t v = r.i64();
        Rs fn = op == rsc::ItemSetVisibilityLayer ? RS_CANVAS_ITEM_SET_VISIBILITY_LAYER
                : op == rsc::ItemSetZIndex        ? RS_CANVAS_ITEM_SET_Z_INDEX
                                                  : RS_CANVAS_ITEM_SET_DRAW_INDEX;
        rs_call(fn, {&item, &v});
        break;
      }
      case rsc::ItemSetDefaultFilter:
      case rsc::ItemSetDefaultRepeat: {
        uint64_t item = r.rid();
        int64_t v = r.u();
        rs_call(op == rsc::ItemSetDefaultFilter ? RS_CANVAS_ITEM_SET_DEFAULT_TEXTURE_FILTER
                                                : RS_CANVAS_ITEM_SET_DEFAULT_TEXTURE_REPEAT,
                {&item, &v});
        break;
      }
      case rsc::ItemSetMaterial: {
        uint64_t item = r.rid();
        uint64_t material = r.rid();
        rs_call(RS_CANVAS_ITEM_SET_MATERIAL, {&item, &material});
        break;
      }
      case rsc::ItemClear: {
        uint64_t item = r.rid();
        rs_call(RS_CANVAS_ITEM_CLEAR, {&item});
        break;
      }
      case rsc::AddRect: {
        uint64_t item = r.rid();
        float rect[4], c[4];
        r.fs(rect, 4);
        r.fs(c, 4);
        GDExtensionBool aa = r.b();
        rs_call(RS_CANVAS_ITEM_ADD_RECT, {&item, rect, c, &aa});
        break;
      }
      case rsc::AddTextureRect: {
        uint64_t item = r.rid();
        float rect[4], c[4];
        r.fs(rect, 4);
        uint64_t tex = r.rid();
        GDExtensionBool tile = r.b();
        r.fs(c, 4);
        GDExtensionBool transpose = r.b();
        rs_call(RS_CANVAS_ITEM_ADD_TEXTURE_RECT, {&item, rect, &tex, &tile, c, &transpose});
        break;
      }
      case rsc::AddTextureRectRegion: {
        uint64_t item = r.rid();
        float rect[4], src[4], c[4];
        r.fs(rect, 4);
        uint64_t tex = r.rid();
        r.fs(src, 4);
        r.fs(c, 4);
        GDExtensionBool transpose = r.b();
        GDExtensionBool clip_uv = r.b();
        rs_call(RS_CANVAS_ITEM_ADD_TEXTURE_RECT_REGION, {&item, rect, &tex, src, c, &transpose, &clip_uv});
        break;
      }
      case rsc::AddMsdfTextureRectRegion: {
        uint64_t item = r.rid();
        float rect[4], src[4], c[4];
        r.fs(rect, 4);
        uint64_t tex = r.rid();
        r.fs(src, 4);
        r.fs(c, 4);
        int64_t outline = r.i64();
        double px_range = r.fd();
        double scale = r.fd();
        rs_call(RS_CANVAS_ITEM_ADD_MSDF_TEXTURE_RECT_REGION,
                {&item, rect, &tex, src, c, &outline, &px_range, &scale});
        break;
      }
      case rsc::AddLine: {
        uint64_t item = r.rid();
        float from[2], to[2], c[4];
        r.fs(from, 2);
        r.fs(to, 2);
        r.fs(c, 4);
        double width = r.fd();
        GDExtensionBool aa = r.b();
        rs_call(RS_CANVAS_ITEM_ADD_LINE, {&item, from, to, c, &width, &aa});
        break;
      }
      case rsc::AddPolyline:
      case rsc::AddMultiline: {
        uint64_t item = r.rid();
        PackedArray points(GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY);
        PackedArray colors(GDEXTENSION_VARIANT_TYPE_PACKED_COLOR_ARRAY);
        r.farray(points, 2);
        r.farray(colors, 4);
        double width = r.fd();
        GDExtensionBool aa = r.b();
        rs_call(op == rsc::AddPolyline ? RS_CANVAS_ITEM_ADD_POLYLINE : RS_CANVAS_ITEM_ADD_MULTILINE,
                {&item, &points.p, &colors.p, &width, &aa});
        break;
      }
      case rsc::AddCircle: {
        uint64_t item = r.rid();
        float pos[2], c[4];
        r.fs(pos, 2);
        double radius = r.fd();
        r.fs(c, 4);
        GDExtensionBool aa = r.b();
        rs_call(RS_CANVAS_ITEM_ADD_CIRCLE, {&item, pos, &radius, c, &aa});
        break;
      }
      case rsc::AddPrimitive:
      case rsc::AddPolygon: {
        uint64_t item = r.rid();
        PackedArray points(GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY);
        PackedArray colors(GDEXTENSION_VARIANT_TYPE_PACKED_COLOR_ARRAY);
        PackedArray uvs(GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY);
        r.farray(points, 2);
        r.farray(colors, 4);
        r.farray(uvs, 2);
        uint64_t tex = r.rid();
        rs_call(op == rsc::AddPrimitive ? RS_CANVAS_ITEM_ADD_PRIMITIVE : RS_CANVAS_ITEM_ADD_POLYGON,
                {&item, &points.p, &colors.p, &uvs.p, &tex});
        break;
      }
      case rsc::AddTriangleArray: {
        uint64_t item = r.rid();
        PackedArray indices(GDEXTENSION_VARIANT_TYPE_PACKED_INT32_ARRAY);
        PackedArray points(GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY);
        PackedArray colors(GDEXTENSION_VARIANT_TYPE_PACKED_COLOR_ARRAY);
        PackedArray uvs(GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY);
        PackedArray bones(GDEXTENSION_VARIANT_TYPE_PACKED_INT32_ARRAY);
        PackedArray weights(GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT32_ARRAY);
        r.iarray(indices);
        r.farray(points, 2);
        r.farray(colors, 4);
        r.farray(uvs, 2);
        uint64_t tex = r.rid();
        int64_t count = r.i64();
        rs_call(RS_CANVAS_ITEM_ADD_TRIANGLE_ARRAY,
                {&item, &indices.p, &points.p, &colors.p, &uvs.p, &bones.p, &weights.p, &tex, &count});
        break;
      }
      case rsc::AddNinePatch: {
        uint64_t item = r.rid();
        float rect[4], source[4], margins[4], c[4];
        r.fs(rect, 4);
        r.fs(source, 4);
        uint64_t tex = r.rid();
        r.fs(margins, 4);
        int64_t x_axis = r.u();
        int64_t y_axis = r.u();
        GDExtensionBool draw_center = r.b();
        r.fs(c, 4);
        rs_call(RS_CANVAS_ITEM_ADD_NINE_PATCH,
                {&item, rect, source, &tex, margins, margins + 2, &x_axis, &y_axis, &draw_center, c});
        break;
      }
      case rsc::AddMesh: {
        uint64_t item = r.rid();
        uint64_t mesh = r.rid();
        float x[6], c[4];
        r.fs(x, 6);
        r.fs(c, 4);
        uint64_t tex = r.rid();
        rs_call(RS_CANVAS_ITEM_ADD_MESH, {&item, &mesh, x, c, &tex});
        break;
      }
      default:
        std::fprintf(stderr, "[rs_core_ext] unknown op %u at word %zu; the rest of this batch is dropped\n", op,
                     r.at - 1);
        return ops;
    }
  }
  inst->executed += ops;
  return ops;
}

// ------------------------------------------------------------------------------ arguments

bool arg_is(GDExtensionConstVariantPtr v, GDExtensionVariantType t) {
  return gd.variant_get_type(v) == t;
}

int64_t arg_int(GDExtensionConstVariantPtr v) {
  int64_t out = 0;
  gd.to[GDEXTENSION_VARIANT_TYPE_INT](&out, const_cast<GDExtensionVariantPtr>(v));
  return out;
}

bool arg_bool(GDExtensionConstVariantPtr v) {
  GDExtensionBool out = 0;
  gd.to[GDEXTENSION_VARIANT_TYPE_BOOL](&out, const_cast<GDExtensionVariantPtr>(v));
  return out != 0;
}

uint64_t arg_rid(GDExtensionConstVariantPtr v) {
  uint64_t out = 0;
  gd.to[GDEXTENSION_VARIANT_TYPE_RID](&out, const_cast<GDExtensionVariantPtr>(v));
  return out;
}

std::string arg_string(GDExtensionConstVariantPtr v) {
  Str s{};
  gd.to[GDEXTENSION_VARIANT_TYPE_STRING](&s, const_cast<GDExtensionVariantPtr>(v));
  GDExtensionInt n = gd.string_to_utf8(&s, nullptr, 0);
  std::string out(static_cast<size_t>(n > 0 ? n : 0), '\0');
  if (n > 0) gd.string_to_utf8(&s, out.data(), n);
  gd.dtor[GDEXTENSION_VARIANT_TYPE_STRING](&s);
  return out;
}

// A PackedByteArray argument, held (COW, no copy) while `data`/`size` are in use.
struct BytesArg {
  Packed p{};
  const uint8_t *data = nullptr;
  size_t size = 0;
  explicit BytesArg(GDExtensionConstVariantPtr v) {
    gd.to[GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY](&p, const_cast<GDExtensionVariantPtr>(v));
    int64_t n = 0;
    gd.pba_size(&p, nullptr, &n, 0);
    size = static_cast<size_t>(n);
    if (size > 0) data = gd.pba_index_const(&p, 0);
  }
  ~BytesArg() { gd.dtor[GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY](&p); }
  BytesArg(const BytesArg &) = delete;
  BytesArg &operator=(const BytesArg &) = delete;
};

void ret_bool(GDExtensionVariantPtr r, bool b) {
  GDExtensionBool v = b;
  gd.from[GDEXTENSION_VARIANT_TYPE_BOOL](r, &v);
}
void ret_int(GDExtensionVariantPtr r, int64_t v) { gd.from[GDEXTENSION_VARIANT_TYPE_INT](r, &v); }

void ret_string(GDExtensionVariantPtr r, const std::string &s) {
  String str(s);
  gd.from[GDEXTENSION_VARIANT_TYPE_STRING](r, &str.s);
}

// ------------------------------------------------------------------------------ methods

enum Method : int {
  M_OPEN,
  M_SESSION,
  M_BEGIN_SESSION,
  M_ACCEPT,
  M_RESOURCE_PAYLOAD,
  M_NEEDED,
  M_PROVIDE,
  M_PROVIDE_LIBRARY,
  M_APPLY,
  M_DISPOSE,
  M_STATE_JSON,
  M_COUNTERS,
  M_SET_FULL_SCAN,
  M_OP_COUNT,
  M_SET_DIGEST_DEFERRED,
  M_RECORD_DIGEST,
  M_STAGE,
  M_UNSTAGE,
  M_APPLY_TIMING,
  M_SET_DELIVERY,
  M_SET_VARIANT_UPGRADE,
  M_SET_TRANSCODE_LOG,
  M_TAKE_TRANSCODES,
  M_PRETRANSCODE,
  M_REFUSE_VARIANT,
  M_COUNT,
};

struct MethodSpec {
  const char *name;
  int args;
};
constexpr MethodSpec METHODS[M_COUNT] = {
    {"open", 3},             // (viewport: RID, root_canvas: RID, sabotage: String) -> String ("" ok)
    {"session", 3},          // (data: PackedByteArray, offset: int, version: int 6..9) -> Dictionary
    {"begin_session", 0},    // () -> int (ops executed)
    {"accept", 2},           // (data: PackedByteArray, offset: int) -> Dictionary
    {"resource_payload", 0}, // () -> PackedByteArray
    {"needed", 0},           // () -> Dictionary
    {"provide", 2},          // (hash: String, data: PackedByteArray) -> String ("" ok)
    {"provide_library", 3},  // (hash: String, ok: bool, code_or_detail: String) -> void
    {"apply", 0},            // () -> Dictionary (stats) or String (error)
    {"dispose", 0},          // () -> int (RIDs freed)
    {"state_json", 0},       // () -> String
    {"counters", 0},         // () -> Dictionary
    {"set_full_scan", 1},    // (on: bool) -> void
    {"op_count", 0},         // () -> int (the core's opcode count, a constant: G7xw's probe call)
    {"set_digest_deferred", 1}, // (on: bool) -> void (G7o2: the next session defers record digests)
    {"record_digest", 2},    // (data: PackedByteArray, offset: int) -> String (sha256 hex, "" on error)
    {"stage", 2},            // (hash: String, data: PackedByteArray) -> String ("" ok; G7o3)
    {"unstage", 1},          // (hash: String) -> void (G7o3)
    {"apply_timing", 0},     // () -> int: the last apply's plan | execute << 21 | stats << 42, in us (G7o3)
    {"set_delivery", 2},     // (texture_encodings: String, gpu_formats: String) -> String ("" ok; G8kp)
    {"set_variant_upgrade", 1}, // (on: bool) -> void (G8ku: D6 upgrade instead of keep)
    {"set_transcode_log", 1}, // (hash_uploads: bool) -> void (G8ku: hash each transcoded upload)
    {"take_transcodes", 0},  // () -> String: a JSON array of the KTX2 transcodes since the last call
    {"pretranscode", 2},     // (hash: String, ktx2: PackedByteArray) -> bool (G8kf: transcode ahead of the apply)
    {"refuse_variant", 1},   // (hash: String) -> void (G8kf: D3 skips this variant; Q3 fallback)
};

void method_call(void *userdata, GDExtensionClassInstancePtr instance, const GDExtensionConstVariantPtr *args,
                 GDExtensionInt argc, GDExtensionVariantPtr ret, GDExtensionCallError *error) {
  auto m = static_cast<Method>(reinterpret_cast<intptr_t>(userdata));
  auto *inst = static_cast<Instance *>(instance);
  error->error = GDEXTENSION_CALL_OK;
  if (argc != METHODS[m].args) {
    error->error = argc < METHODS[m].args ? GDEXTENSION_CALL_ERROR_TOO_FEW_ARGUMENTS
                                          : GDEXTENSION_CALL_ERROR_TOO_MANY_ARGUMENTS;
    error->expected = METHODS[m].args;
    return;
  }
  switch (m) {
    case M_OPEN: {
      if (!engine_ready()) {
        ret_string(ret, "rs-core-ext: " + engine.error);
        return;
      }
      if (rsc_op_count() != rsc::OP_COUNT) {
        ret_string(ret, "rs-core-ext: the core's op table does not match the shim's");
        return;
      }
      inst->viewport = arg_rid(args[0]);
      inst->root_canvas = arg_rid(args[1]);
      std::string sabotage = arg_string(args[2]);
      rsc_set_sabotage(inst->core, reinterpret_cast<const uint8_t *>(sabotage.data()), sabotage.size());
      ret_string(ret, "");
      return;
    }
    case M_SESSION:
    case M_ACCEPT: {
      if (!arg_is(args[0], GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY)) {
        error->error = GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;
        error->argument = 0;
        error->expected = GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY;
        return;
      }
      BytesArg data(args[0]);
      int64_t offset = arg_int(args[1]);
      if (offset < 0) offset = static_cast<int64_t>(data.size) + 1;
      if (m == M_SESSION) {
        // G7xwl: the stream's wire version (receiver.gd's _wire_version); the core refuses
        // anything but 6 and 7, so an out-of-range int is clamped to 0 rather than truncated.
        int64_t version = arg_int(args[2]);
        uint32_t v = version >= 0 && version <= 255 ? static_cast<uint32_t>(version) : 0;
        rsc_session(inst->core, data.data, data.size, static_cast<size_t>(offset), v);
      } else {
        rsc_accept(inst->core, data.data, data.size, static_cast<size_t>(offset));
      }
      vt_variant(inst, static_cast<Variant *>(ret));
      return;
    }
    case M_BEGIN_SESSION:
      rsc_begin_session(inst->core);
      ret_int(ret, execute(inst));
      return;
    case M_RESOURCE_PAYLOAD:
      rsc_resource_payload(inst->core);
      text_bytes(inst, static_cast<Variant *>(ret));
      return;
    case M_NEEDED:
      rsc_needed(inst->core);
      vt_variant(inst, static_cast<Variant *>(ret));
      return;
    case M_PROVIDE: {
      std::string hash = arg_string(args[0]);
      BytesArg data(args[1]);
      if (rsc_provide(inst->core, reinterpret_cast<const uint8_t *>(hash.data()), hash.size(), data.data,
                      data.size) == 1) {
        ret_string(ret, "");
      } else {
        text_string(inst, static_cast<Variant *>(ret));
      }
      return;
    }
    case M_PROVIDE_LIBRARY: {
      std::string hash = arg_string(args[0]);
      bool ok = arg_bool(args[1]);
      std::string body = arg_string(args[2]);
      rsc_provide_library(inst->core, reinterpret_cast<const uint8_t *>(hash.data()), hash.size(), ok ? 1 : 0,
                          reinterpret_cast<const uint8_t *>(body.data()), body.size());
      return;
    }
    case M_APPLY: {
      using clock = std::chrono::steady_clock;
      auto us = [](clock::time_point a, clock::time_point b) {
        return static_cast<int64_t>(std::chrono::duration_cast<std::chrono::microseconds>(b - a).count());
      };
      clock::time_point t0 = clock::now();
      if (rsc_apply(inst->core) == 1) {
        clock::time_point t1 = clock::now();
        execute(inst);
        clock::time_point t2 = clock::now();
        vt_variant(inst, static_cast<Variant *>(ret));
        clock::time_point t3 = clock::now();
        inst->apply_plan_us = us(t0, t1);
        inst->apply_execute_us = us(t1, t2);
        inst->apply_stats_us = us(t2, t3);
      } else {
        text_string(inst, static_cast<Variant *>(ret));
      }
      release_pretranscoded(inst);  // G8kf: images of files this apply did not use
      return;
    }
    case M_STAGE: {
      std::string hash = arg_string(args[0]);
      BytesArg data(args[1]);
      if (rsc_stage(inst->core, reinterpret_cast<const uint8_t *>(hash.data()), hash.size(), data.data,
                    data.size) == 1) {
        ret_string(ret, "");
      } else {
        text_string(inst, static_cast<Variant *>(ret));
      }
      return;
    }
    case M_UNSTAGE: {
      std::string hash = arg_string(args[0]);
      rsc_unstage(inst->core, reinterpret_cast<const uint8_t *>(hash.data()), hash.size());
      return;
    }
    case M_SET_DELIVERY: {
      std::string encodings = arg_string(args[0]);
      std::string gpu_formats = arg_string(args[1]);
      if (rsc_set_delivery(inst->core, reinterpret_cast<const uint8_t *>(encodings.data()),
                           encodings.size(), reinterpret_cast<const uint8_t *>(gpu_formats.data()),
                           gpu_formats.size()) == 1) {
        ret_string(ret, "");
      } else {
        text_string(inst, static_cast<Variant *>(ret));
      }
      return;
    }
    case M_SET_VARIANT_UPGRADE: {
      rsc_set_variant_upgrade(inst->core, arg_bool(args[0]) ? 1 : 0);
      return;
    }
    case M_SET_TRANSCODE_LOG: {
      inst->hash_uploads = arg_bool(args[0]);
      return;
    }
    case M_PRETRANSCODE: {
      BytesArg data(args[1]);
      ret_bool(ret, pretranscode_ktx2(data.data, data.size, inst));
      return;
    }
    case M_REFUSE_VARIANT: {
      std::string hash = arg_string(args[0]);
      rsc_refuse_variant(inst->core, reinterpret_cast<const uint8_t *>(hash.data()), hash.size());
      return;
    }
    case M_TAKE_TRANSCODES: {
      ret_string(ret, "[" + inst->transcodes + "]");
      inst->transcodes.clear();
      return;
    }
    case M_APPLY_TIMING: {
      auto clamp21 = [](int64_t v) { return v < 0 ? 0 : (v > 0x1FFFFF ? 0x1FFFFF : v); };
      ret_int(ret, clamp21(inst->apply_plan_us) | (clamp21(inst->apply_execute_us) << 21) |
                       (clamp21(inst->apply_stats_us) << 42));
      return;
    }
    case M_DISPOSE: {
      int64_t n = rsc_dispose(inst->core);
      execute(inst);
      ret_int(ret, n);
      return;
    }
    case M_STATE_JSON:
      rsc_state_json(inst->core);
      text_string(inst, static_cast<Variant *>(ret));
      return;
    case M_COUNTERS:
      rsc_counters(inst->core);
      vt_variant(inst, static_cast<Variant *>(ret));
      return;
    case M_SET_FULL_SCAN:
      rsc_set_full_scan(inst->core, arg_bool(args[0]) ? 1 : 0);
      return;
    case M_OP_COUNT:
      ret_int(ret, rsc_op_count());
      return;
    case M_SET_DIGEST_DEFERRED:
      rsc_set_digest_deferred(inst->core, arg_bool(args[0]) ? 1 : 0);
      return;
    case M_RECORD_DIGEST: {
      if (!arg_is(args[0], GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY)) {
        error->error = GDEXTENSION_CALL_ERROR_INVALID_ARGUMENT;
        error->argument = 0;
        error->expected = GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY;
        return;
      }
      BytesArg data(args[0]);
      int64_t offset = arg_int(args[1]);
      if (offset < 0) offset = static_cast<int64_t>(data.size) + 1;
      if (rsc_record_digest(inst->core, data.data, data.size, static_cast<size_t>(offset)) == 1) {
        text_string(inst, static_cast<Variant *>(ret));
      } else {
        ret_string(ret, "");
      }
      return;
    }
    case M_COUNT:
      return;
  }
}

void method_ptrcall(void *, GDExtensionClassInstancePtr, const GDExtensionConstTypePtr *, GDExtensionTypePtr) {
  // RsCore is reached through Object.call() only (receiver.gd cannot type it statically).
  std::fprintf(stderr, "[rs_core_ext] ptrcall into RsCore is not supported\n");
}

// ------------------------------------------------------------------------------ class

const char *CLASS_NAME = "RsCore";

GDExtensionObjectPtr create_instance(void *, GDExtensionBool) {
  StringName parent("RefCounted");
  StringName cls(CLASS_NAME);
  GDExtensionObjectPtr object = gd.construct_object(parent.ptr());
  auto *inst = new Instance();
  inst->core = rsc_new();
  gd.object_set_instance(object, cls.ptr(), inst);
  return object;
}

void free_instance(void *, GDExtensionClassInstancePtr instance) {
  release_pretranscoded(static_cast<Instance *>(instance));
  auto *inst = static_cast<Instance *>(instance);
  rsc_free(inst->core);
  delete inst;
}

void register_class() {
  StringName cls(CLASS_NAME);
  StringName parent("RefCounted");
  GDExtensionClassCreationInfo5 info{};
  info.is_exposed = true;
  info.create_instance_func = create_instance;
  info.free_instance_func = free_instance;
  gd.register_class(gd.library, cls.ptr(), parent.ptr(), &info);
  for (int i = 0; i < M_COUNT; i++) {
    StringName name(METHODS[i].name);
    StringName empty("");
    std::vector<StringName *> arg_names;
    std::vector<GDExtensionPropertyInfo> args(static_cast<size_t>(METHODS[i].args));
    std::vector<GDExtensionClassMethodArgumentMetadata> meta(args.size(), GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE);
    Str hint{};
    gd.string_utf8(&hint, "", 0);
    for (size_t a = 0; a < args.size(); a++) {
      std::string an = "arg" + std::to_string(a);
      arg_names.push_back(new StringName(an.c_str()));
      args[a].type = GDEXTENSION_VARIANT_TYPE_NIL;
      args[a].name = const_cast<void *>(arg_names.back()->ptr());
      args[a].class_name = const_cast<void *>(empty.ptr());
      args[a].hint = 0;
      args[a].hint_string = &hint;
      args[a].usage = 6 | 131072;  // PROPERTY_USAGE_DEFAULT | PROPERTY_USAGE_NIL_IS_VARIANT
    }
    GDExtensionPropertyInfo ret{};
    ret.type = GDEXTENSION_VARIANT_TYPE_NIL;
    ret.name = const_cast<void *>(empty.ptr());
    ret.class_name = const_cast<void *>(empty.ptr());
    ret.hint_string = &hint;
    ret.usage = 6 | 131072;
    GDExtensionClassMethodInfo mi{};
    mi.name = const_cast<void *>(name.ptr());
    mi.method_userdata = reinterpret_cast<void *>(static_cast<intptr_t>(i));
    mi.call_func = method_call;
    mi.ptrcall_func = method_ptrcall;
    mi.method_flags = GDEXTENSION_METHOD_FLAGS_DEFAULT;
    mi.has_return_value = true;
    mi.return_value_info = &ret;
    mi.return_value_metadata = GDEXTENSION_METHOD_ARGUMENT_METADATA_NONE;
    mi.argument_count = static_cast<uint32_t>(args.size());
    mi.arguments_info = args.data();
    mi.arguments_metadata = meta.data();
    gd.register_method(gd.library, cls.ptr(), &mi);
    for (StringName *s : arg_names) delete s;
    gd.dtor[GDEXTENSION_VARIANT_TYPE_STRING](&hint);
  }
}

bool load(GDExtensionInterfaceGetProcAddress get, GDExtensionClassLibraryPtr library) {
  gd.library = library;
  bool ok = true;
  ok &= bind(get, "global_get_singleton", &gd.global_get_singleton);
  ok &= bind(get, "classdb_get_method_bind", &gd.classdb_get_method_bind);
  ok &= bind(get, "object_method_bind_ptrcall", &gd.ptrcall);
  ok &= bind(get, "object_destroy", &gd.object_destroy);
  ok &= bind(get, "object_set_instance", &gd.object_set_instance);
  ok &= bind(get, "classdb_construct_object2", &gd.construct_object);
  ok &= bind(get, "classdb_register_extension_class5", &gd.register_class);
  ok &= bind(get, "classdb_register_extension_class_method", &gd.register_method);
  ok &= bind(get, "classdb_unregister_extension_class", &gd.unregister_class);
  ok &= bind(get, "string_name_new_with_latin1_chars", &gd.string_name_latin1);
  ok &= bind(get, "string_name_new_with_utf8_chars_and_len", &gd.string_name_utf8);
  ok &= bind(get, "string_new_with_utf8_chars_and_len2", &gd.string_utf8);
  ok &= bind(get, "string_to_utf8_chars", &gd.string_to_utf8);
  ok &= bind(get, "variant_new_nil", &gd.variant_new_nil);
  ok &= bind(get, "variant_new_copy", &gd.variant_new_copy);
  ok &= bind(get, "variant_destroy", &gd.variant_destroy);
  ok &= bind(get, "variant_get_type", &gd.variant_get_type);
  ok &= bind(get, "get_variant_from_type_constructor", &gd.get_from_type);
  ok &= bind(get, "get_variant_to_type_constructor", &gd.get_to_type);
  ok &= bind(get, "variant_get_ptr_constructor", &gd.get_ptr_constructor);
  ok &= bind(get, "variant_get_ptr_destructor", &gd.get_ptr_destructor);
  ok &= bind(get, "variant_get_ptr_builtin_method", &gd.get_builtin_method);
  ok &= bind(get, "packed_byte_array_operator_index", &gd.pba_index);
  ok &= bind(get, "packed_byte_array_operator_index_const", &gd.pba_index_const);
  ok &= bind(get, "packed_int32_array_operator_index", &gd.pi32_index);
  ok &= bind(get, "packed_int64_array_operator_index", &gd.pi64_index);
  ok &= bind(get, "packed_float32_array_operator_index", &gd.pf32_index);
  ok &= bind(get, "packed_float64_array_operator_index", &gd.pf64_index);
  ok &= bind(get, "packed_vector2_array_operator_index", &gd.pv2_index);
  ok &= bind(get, "packed_vector3_array_operator_index", &gd.pv3_index);
  ok &= bind(get, "packed_vector4_array_operator_index", &gd.pv4_index);
  ok &= bind(get, "packed_color_array_operator_index", &gd.pcolor_index);
  ok &= bind(get, "dictionary_operator_index", &gd.dict_index);
  if (!ok) return false;
  for (int t = 1; t < GDEXTENSION_VARIANT_TYPE_VARIANT_MAX; t++) {
    auto type = static_cast<GDExtensionVariantType>(t);
    gd.from[t] = gd.get_from_type(type);
    gd.to[t] = gd.get_to_type(type);
    gd.ctor[t] = gd.get_ptr_constructor(type, 0);
    gd.dtor[t] = gd.get_ptr_destructor(type);
  }
  // Builtin methods need StringNames, which need the destructors just fetched.
  const GDExtensionVariantType packed[] = {
      GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY,    GDEXTENSION_VARIANT_TYPE_PACKED_INT32_ARRAY,
      GDEXTENSION_VARIANT_TYPE_PACKED_INT64_ARRAY,   GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT32_ARRAY,
      GDEXTENSION_VARIANT_TYPE_PACKED_FLOAT64_ARRAY, GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR2_ARRAY,
      GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR3_ARRAY, GDEXTENSION_VARIANT_TYPE_PACKED_VECTOR4_ARRAY,
      GDEXTENSION_VARIANT_TYPE_PACKED_COLOR_ARRAY,
  };
  StringName resize("resize"), size("size"), push_back("push_back");
  for (auto t : packed) {
    gd.resize[t] = gd.get_builtin_method(t, resize.ptr(), 848867239);
    if (gd.resize[t] == nullptr) return false;
  }
  gd.pba_size = gd.get_builtin_method(GDEXTENSION_VARIANT_TYPE_PACKED_BYTE_ARRAY, size.ptr(), 3173160232);
  gd.array_push_back = gd.get_builtin_method(GDEXTENSION_VARIANT_TYPE_ARRAY, push_back.ptr(), 3316032543);
  gd.strings_push_back =
      gd.get_builtin_method(GDEXTENSION_VARIANT_TYPE_PACKED_STRING_ARRAY, push_back.ptr(), 816187996);
  return gd.pba_size != nullptr && gd.array_push_back != nullptr && gd.strings_push_back != nullptr;
}

bool g_loaded = false;

void initialize(void *, GDExtensionInitializationLevel level) {
  if (level != GDEXTENSION_INITIALIZATION_SCENE || !g_loaded) return;
  register_class();
}

void deinitialize(void *, GDExtensionInitializationLevel level) {
  if (level != GDEXTENSION_INITIALIZATION_SCENE || !g_loaded) return;
  StringName cls(CLASS_NAME);
  gd.unregister_class(gd.library, cls.ptr());
}

}  // namespace

extern "C" __attribute__((visibility("default"))) GDExtensionBool rs_core_ext_init(
    GDExtensionInterfaceGetProcAddress get_proc_address, GDExtensionClassLibraryPtr library,
    GDExtensionInitialization *init) {
  g_loaded = load(get_proc_address, library);
  if (!g_loaded) {
    std::fprintf(stderr, "[rs_core_ext] the engine lacks %s; RsCore is not registered\n",
                 g_missing.empty() ? "a builtin method" : g_missing.c_str());
    return false;
  }
  init->initialize = initialize;
  init->deinitialize = deinitialize;
  init->userdata = nullptr;
  init->minimum_initialization_level = GDEXTENSION_INITIALIZATION_SCENE;
  return true;
}
