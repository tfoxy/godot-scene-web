#include "abi.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <set>
#include <string>
#include <typeinfo>

#if defined(_MSC_VER)
#error "the MSVC ABI is not supported"
#endif

using grc::Color;
using grc::Rect2;
using grc::RID;
using grc::Transform2D;
using grc::Vector2;

struct VariantLike {
  uint32_t type, pad;
  uint64_t a, b;
};
static_assert(sizeof(VariantLike) == 24);

namespace {
struct Mixed {
  int32_t a;
  float b;
  int64_t c;
  double d;
  uint32_t e;
  float f;
  RID g;
  float h;
  int32_t i;
};
struct Record {
  void *self = nullptr;
  uint64_t seed = 0;
  int32_t idx = 0, salt = 0;
  float scale = 0;
  Mixed mixed{};
  RID item{};
  const Rect2 *rect = nullptr;
  const VariantLike *variant = nullptr;
  const Color *color = nullptr;
  Rect2 rect_value{};
  VariantLike variant_value{};
  Color color_value{};
  bool flag = false;
  void *ret = nullptr;
  RID texture{};
  const Rect2 *source = nullptr;
  const Vector2 *topleft = nullptr, *bottomright = nullptr;
  int32_t x_axis = 0;
  int64_t y_axis = 0;
  Color hfa{};
  const void *arrays[6]{};
  int count = 0;
};
Record member_record, hook_record;

template <typename T> bool bits(const T &a, const T &b) {
  return std::memcmp(&a, &b, sizeof(T)) == 0;
}
bool same_mixed(const Mixed &a, const Mixed &b) {
  return a.a == b.a && bits(a.b, b.b) && a.c == b.c && bits(a.d, b.d) &&
         a.e == b.e && bits(a.f, b.f) && a.g.id == b.g.id && bits(a.h, b.h) &&
         a.i == b.i;
}
Color color_value(int32_t idx, int32_t salt) {
  return {idx + .25f, idx + .5f, salt + .75f, salt + 1.f};
}
Transform2D xform_value(RID r) {
  const float n = static_cast<float>(r.id);
  return {{{n, n + 1}, {n + 2, n + 3}, {n + 4, n + 5}}};
}
void record_rect(Record &dst, void *self, RID item, const Rect2 *r,
                 const VariantLike *v, const Color *c, bool flag) {
  dst.self = self;
  dst.item = item;
  dst.rect = r;
  dst.variant = v;
  dst.color = c;
  dst.rect_value = *r;
  dst.variant_value = *v;
  dst.color_value = *c;
  dst.flag = flag;
}
} // namespace

// Keep the class global and non-final: the probe checks its Itanium name and
// virtual slots.
class GrcAbiProbe {
public:
  virtual ~GrcAbiProbe() = default;
  virtual RID make_rid(uint64_t seed) {
    member_record.self = this;
    member_record.seed = seed;
    return {seed * 3 + 1};
  }
  virtual Color get_color(int32_t idx, int32_t salt) {
    member_record.self = this;
    member_record.idx = idx;
    member_record.salt = salt;
    return color_value(idx, salt);
  }
  virtual Vector2 get_vec(float s) {
    member_record.self = this;
    member_record.scale = s;
    return {s, -s};
  }
  virtual void mixed9(int32_t a, float b, int64_t c, double d, uint32_t e,
                      float f, RID g, float h, int32_t i) {
    member_record.self = this;
    member_record.mixed = {a, b, c, d, e, f, g, h, i};
  }
  virtual void rect_variant(RID item, const Rect2 &r, const VariantLike &v,
                            const Color &c, bool flag) {
    record_rect(member_record, this, item, &r, &v, &c, flag);
  }
  virtual Transform2D get_xform(RID r) {
    member_record.self = this;
    member_record.item = r;
    return xform_value(r);
  }
  virtual void nine_patch(RID item, const Rect2 &rect, const Rect2 &source, RID texture,
                          const Vector2 &topleft, const Vector2 &bottomright, int32_t x_axis,
                          int32_t y_axis, bool center, const Color &color) {
    member_record.self = this;
    member_record.item = item;
    member_record.rect = &rect;
    member_record.source = &source;
    member_record.texture = texture;
    member_record.topleft = &topleft;
    member_record.bottomright = &bottomright;
    member_record.x_axis = x_axis;
    member_record.y_axis = y_axis;
    member_record.flag = center;
    member_record.color = &color;
  }
  virtual Color hfa(Color color, float scale) {
    member_record.self = this;
    member_record.hfa = color;
    member_record.scale = scale;
    return {color.r * scale, color.g * scale, color.b * scale, color.a * scale};
  }
  virtual void triangle_array(RID item, const void *indices, const void *points,
                              const void *colors, const void *uvs, const void *bones,
                              const void *weights, RID texture, int32_t count) {
    member_record.self = this;
    member_record.item = item;
    const void *arrays[] = {indices, points, colors, uvs, bones, weights};
    std::memcpy(member_record.arrays, arrays, sizeof(arrays));
    member_record.texture = texture;
    member_record.count = count;
  }

};

namespace {
using RidFn = RID (*)(void *, uint64_t);
using ColorFn = Color (*)(void *, int32_t, int32_t);
using VecFn = Vector2 (*)(void *, float);
using MixedFn = void (*)(void *, int32_t, float, int64_t, double, uint32_t,
                         float, RID, float, int32_t);
using RectFn = void (*)(void *, RID, const Rect2 *, const VariantLike *,
                        const Color *, bool);
using XformFn = Transform2D (*)(void *, RID);
RidFn original_rid;
ColorFn original_color;
VecFn original_vec;
MixedFn original_mixed;
RectFn original_rect;
XformFn original_xform;
using NineFn = void (*)(void *, RID, const Rect2 *, const Rect2 *, RID,
                        const Vector2 *, const Vector2 *, int32_t, int32_t, bool, const Color *);
using HfaFn = Color (*)(void *, Color, float);
using TriangleFn = void (*)(void *, RID, const void *, const void *, const void *, const void *,
                           const void *, const void *, RID, int32_t);
NineFn original_nine;
HfaFn original_hfa;
TriangleFn original_triangle;

RID hook_rid(void *self, uint64_t seed) {
  hook_record.self = self;
  hook_record.seed = seed;
  RID r = original_rid(self, seed);
  r.id += 1000;
  return r;
}
#if defined(GRC_PROBE_MSVC_ORDER)
Color *hook_color(void *self, Color *ret, int32_t idx, int32_t salt) {
  hook_record.self = self;
  hook_record.ret = ret;
  hook_record.idx = idx;
  hook_record.salt = salt;
  return ret;
}
Transform2D *hook_xform(void *self, Transform2D *ret, RID r) {
  hook_record.self = self;
  hook_record.ret = ret;
  hook_record.item = r;
  return ret;
}
#else
Color hook_color(void *self, int32_t idx, int32_t salt) {
  hook_record.self = self;
  hook_record.idx = idx;
  hook_record.salt = salt;
  Color c = original_color(self, idx, salt);
  c.r += 100;
  c.g += 100;
  c.b += 100;
  c.a += 100;
  return c;
}
Transform2D hook_xform(void *self, RID r) {
  hook_record.self = self;
  hook_record.item = r;
  Transform2D t = original_xform(self, r);
  for (auto &col : t.columns) {
    col.x += 100;
    col.y += 100;
  }
  return t;
}
#endif
Vector2 hook_vec(void *self, float s) {
  hook_record.self = self;
  hook_record.scale = s;
  Vector2 v = original_vec(self, s);
  v.x += 100;
  v.y += 100;
  return v;
}
void hook_mixed(void *self, int32_t a, float b, int64_t c, double d, uint32_t e,
                float f, RID g, float h, int32_t i) {
  hook_record.self = self;
  hook_record.mixed = {a, b, c, d, e, f, g, h, i};
  original_mixed(self, a, b, c, d, e, f, g, h, i);
}
void hook_rect(void *self, RID item, const Rect2 *r, const VariantLike *v,
               const Color *c, bool flag) {
  record_rect(hook_record, self, item, r, v, c, flag);
  original_rect(self, item, r, v, c, flag);
}

#if defined(GRC_PROBE_STACK_WIDTH)
using StackAxis = int64_t;
#else
using StackAxis = int32_t;
#endif
// y_axis is the first stack argument on Apple arm64. Widening it moves center from sp+4 to
// sp+8 and color from sp+8 to sp+16. Never dereference the sabotaged color pointer.
void hook_nine(void *self, RID item, const Rect2 *rect, const Rect2 *source, RID texture,
               const Vector2 *topleft, const Vector2 *bottomright, int32_t x_axis,
               StackAxis y_axis, bool center, const Color *color) {
  hook_record.self = self;
  hook_record.item = item;
  hook_record.rect = rect;
  hook_record.source = source;
  hook_record.texture = texture;
  hook_record.topleft = topleft;
  hook_record.bottomright = bottomright;
  hook_record.x_axis = x_axis;
  hook_record.y_axis = static_cast<int32_t>(y_axis);
  hook_record.flag = center;
  hook_record.color = color;
  original_nine(self, item, rect, source, texture, topleft, bottomright, x_axis,
                static_cast<int32_t>(y_axis), center, color);
}
Color hook_hfa(void *self, Color color, float scale) {
  hook_record.self = self;
  hook_record.hfa = color;
  hook_record.scale = scale;
  return original_hfa(self, color, scale);
}
void hook_triangle(void *self, RID item, const void *indices, const void *points,
                   const void *colors, const void *uvs, const void *bones,
                   const void *weights, RID texture, int32_t count) {
  hook_record.self = self;
  hook_record.item = item;
  const void *arrays[] = {indices, points, colors, uvs, bones, weights};
  std::memcpy(hook_record.arrays, arrays, sizeof(arrays));
  hook_record.texture = texture;
  hook_record.count = count;
  original_triangle(self, item, indices, points, colors, uvs, bones, weights, texture, count);
}

GrcAbiProbe *volatile g_object = nullptr;
__attribute__((noinline)) GrcAbiProbe *make_object() { return new GrcAbiProbe; }

template <typename T> std::ptrdiff_t slot(T member) {
  struct MemberPointer {
    std::ptrdiff_t ptr, adjustment;
  } p{};
  static_assert(sizeof(member) == sizeof(p));
  std::memcpy(&p, &member, sizeof(p));
#if defined(__APPLE__) && defined(__aarch64__)
  // Apple's ARM member-pointer representation stores the virtual bit in the adjustment.
  return (p.adjustment & 1) && (p.adjustment >> 1) == 0 ? p.ptr / 8 : -1;
#else
  return (p.ptr & 1) && p.adjustment == 0 ? (p.ptr - 1) / 8 : -1;
#endif
}
int total = 0;
std::set<std::string> failed;
void check(bool ok, const char *name, const char *detail) {
  ++total;
  if (ok) {
    std::printf("ok   %s %s\n", name, detail);
  } else {
    failed.insert(name);
    std::printf("FAIL %s: %s\n", name, detail);
  }
}
} // namespace

int main(int argc, char **argv) {
  std::set<std::string> expected_failures;
  if (argc != 1) {
    if (argc != 3 || std::strcmp(argv[1], "--expect-fail") != 0 || !*argv[2]) {
      std::fprintf(stderr, "usage: abi_convention_probe [--expect-fail a,b]\n");
      return 2;
    }
    std::string names = argv[2];
    for (std::size_t start = 0;;) {
      const auto end = names.find(',', start);
      const auto name = names.substr(start, end - start);
      if (name.empty() || !expected_failures.insert(name).second)
        return 2;
      if (end == std::string::npos)
        break;
      start = end + 1;
    }
  }
#if defined(_WIN32)
  const char *abi = "win64";
#elif defined(__APPLE__) && defined(__aarch64__)
  const char *abi = "apple-aapcs64";
#elif defined(__APPLE__)
  const char *abi = "apple-x86_64";
#else
  const char *abi = "sysv";
#endif
#if defined(GRC_PROBE_MSVC_ORDER)
  const char *variant = "msvc-order";
#elif defined(GRC_PROBE_STACK_WIDTH)
  const char *variant = "stack-width";
#else
  const char *variant = "itanium";
#endif
  std::printf("abi_convention_probe: abi=%s variant=%s\n", abi, variant);
  g_object = make_object();
  GrcAbiProbe *object = g_object;
  auto **location = reinterpret_cast<void ***>(object);
  void **live = __atomic_load_n(location, __ATOMIC_ACQUIRE);
  check(live[-2] == nullptr && live[-1] == &typeid(GrcAbiProbe),
        "vtable-prefix", "offset and RTTI");
  check(std::strcmp(typeid(*object).name(), "11GrcAbiProbe") == 0, "rtti-name",
        "11GrcAbiProbe");
  check(
      slot(&GrcAbiProbe::make_rid) == 2 && slot(&GrcAbiProbe::get_color) == 3 &&
          slot(&GrcAbiProbe::get_vec) == 4 && slot(&GrcAbiProbe::mixed9) == 5 &&
          slot(&GrcAbiProbe::rect_variant) == 6 &&
          slot(&GrcAbiProbe::get_xform) == 7 &&
          slot(&GrcAbiProbe::nine_patch) == 8 && slot(&GrcAbiProbe::hfa) == 9 &&
          slot(&GrcAbiProbe::triangle_array) == 10,
      "slot-index", "2,3,4,5,6,7,8,9,10");
  original_rid = reinterpret_cast<RidFn>(live[2]);
  original_color = reinterpret_cast<ColorFn>(live[3]);
  original_vec = reinterpret_cast<VecFn>(live[4]);
  original_mixed = reinterpret_cast<MixedFn>(live[5]);
  original_rect = reinterpret_cast<RectFn>(live[6]);
  original_xform = reinterpret_cast<XformFn>(live[7]);
  original_nine = reinterpret_cast<NineFn>(live[8]);
  original_hfa = reinterpret_cast<HfaFn>(live[9]);
  original_triangle = reinterpret_cast<TriangleFn>(live[10]);
  constexpr uint64_t seed = 0x5EED;
  constexpr int32_t idx = 0x11, salt = 0x22;
  constexpr float scale = -3.25f;
  const Mixed args{-7,         1.5f,  0x1122334455667788,      -2.25,
                   0xDEADBEEF, 3.75f, RID{0xABCDEF0123456789}, -0.125f,
                   42};
  const RID item{37};
  const Rect2 rect{{1.25f, -2.5f}, {3.75f, 4.125f}};
  const VariantLike value{17, 0, 0x123456789ABCDEF0, 0xFEDCBA9876543210};
  const Color color{.125f, .25f, .5f, 1.f};
  auto rect_matches = [&](const Record &r) {
    return r.self == object && r.item.id == item.id && r.rect == &rect &&
           r.variant == &value && r.color == &color &&
           bits(r.rect_value, rect) && bits(r.variant_value, value) &&
           bits(r.color_value, color) && r.flag;
  };
  RID rid = original_rid(object, seed);
  RID member_rid = g_object->make_rid(seed);
  check(rid.id == member_rid.id && member_record.self == object &&
            member_record.seed == seed,
        "direct-rid", "free function and member agree");
  Color c = original_color(object, idx, salt);
  Color member_color = g_object->get_color(idx, salt);
  check(bits(c, member_color) && member_record.self == object &&
            member_record.idx == idx && member_record.salt == salt,
        "direct-color", "free function and member agree");
  Vector2 v = original_vec(object, scale);
  Vector2 member_vec = g_object->get_vec(scale);
  check(bits(v, member_vec) && member_record.self == object &&
            bits(member_record.scale, scale),
        "direct-vec", "free function and member agree");
  original_mixed(object, args.a, args.b, args.c, args.d, args.e, args.f, args.g,
                 args.h, args.i);
  check(member_record.self == object && same_mixed(member_record.mixed, args),
        "direct-mixed9", "all register and stack arguments");
  original_rect(object, item, &rect, &value, &color, true);
  check(rect_matches(member_record), "direct-rect",
        "reference identity and values");
  Transform2D t = original_xform(object, item);
  Transform2D member_xform = g_object->get_xform(item);
  check(bits(t, member_xform) && member_record.self == object &&
            member_record.item.id == item.id,
        "direct-xform", "free function and member agree");

  // Two prefix words, two destructor slots and nine method slots.
  auto **storage = static_cast<void **>(std::calloc(2 + 11, sizeof(void *)));
  if (!storage) {
    delete object;
    return 1;
  }
  std::memcpy(storage, live - 2, (2 + 11) * sizeof(void *));
  void **shadow = storage + 2;
  shadow[2] = reinterpret_cast<void *>(&hook_rid);
  shadow[3] = reinterpret_cast<void *>(&hook_color);
  shadow[4] = reinterpret_cast<void *>(&hook_vec);
  shadow[5] = reinterpret_cast<void *>(&hook_mixed);
  shadow[6] = reinterpret_cast<void *>(&hook_rect);
  shadow[7] = reinterpret_cast<void *>(&hook_xform);
  shadow[8] = reinterpret_cast<void *>(&hook_nine);
  shadow[9] = reinterpret_cast<void *>(&hook_hfa);
  shadow[10] = reinterpret_cast<void *>(&hook_triangle);
  __atomic_store_n(location, shadow, __ATOMIC_RELEASE);
  member_record = {};
  hook_record = {};
  rid = g_object->make_rid(seed);
  check(hook_record.self == object && hook_record.seed == seed &&
            member_record.self == object && member_record.seed == seed &&
            rid.id == seed * 3 + 1 + 1000,
        "hook-rid", "self, seed, forwarding and transformed return");
  member_record = {};
  hook_record = {};
  c = g_object->get_color(idx, salt);
  Color expected_color = color_value(idx, salt);
  expected_color.r += 100;
  expected_color.g += 100;
  expected_color.b += 100;
  expected_color.a += 100;
  char color_detail[192];
  std::snprintf(color_detail, sizeof(color_detail),
                "self=%p object=%p idx=0x%x want=0x%x; forwarding and return",
                hook_record.self, static_cast<void *>(object),
                static_cast<unsigned>(hook_record.idx),
                static_cast<unsigned>(idx));
  check(hook_record.self == object && hook_record.idx == idx &&
            hook_record.salt == salt && member_record.self == object &&
            member_record.idx == idx && member_record.salt == salt &&
            bits(c, expected_color),
        "hook-color", color_detail);
  member_record = {};
  hook_record = {};
  v = g_object->get_vec(scale);
  const Vector2 expected_vec{scale + 100, -scale + 100};
  check(hook_record.self == object && bits(hook_record.scale, scale) &&
            member_record.self == object && bits(member_record.scale, scale) &&
            bits(v, expected_vec),
        "hook-vec", "self, scale, forwarding and transformed return");
  member_record = {};
  hook_record = {};
  g_object->mixed9(args.a, args.b, args.c, args.d, args.e, args.f, args.g,
                   args.h, args.i);
  check(hook_record.self == object && same_mixed(hook_record.mixed, args) &&
            member_record.self == object &&
            same_mixed(member_record.mixed, args),
        "hook-mixed9", "self and all forwarded register and stack arguments");
  member_record = {};
  hook_record = {};
  g_object->rect_variant(item, rect, value, color, true);
  check(rect_matches(hook_record) && rect_matches(member_record), "hook-rect",
        "self, forwarded reference identity and values");
  member_record = {};
  hook_record = {};
  t = g_object->get_xform(item);
  Transform2D expected_xform = xform_value(item);
  for (auto &col : expected_xform.columns) {
    col.x += 100;
    col.y += 100;
  }
  char xform_detail[192];
  std::snprintf(xform_detail, sizeof(xform_detail),
                "self=%p object=%p; RID, forwarding and transformed return",
                hook_record.self, static_cast<void *>(object));
  check(hook_record.self == object && hook_record.item.id == item.id &&
            member_record.self == object && member_record.item.id == item.id &&
            bits(t, expected_xform),
        "hook-xform", xform_detail);
  const Vector2 margin1{3, 4}, margin2{5, 6};
  auto nine_matches = [&](const Record &r) {
    return r.self == object && r.item.id == item.id && r.rect == &rect &&
           r.source == &rect && r.texture.id == seed && r.topleft == &margin1 &&
           r.bottomright == &margin2 && r.x_axis == 2 && r.y_axis == 1 &&
           r.flag && r.color == &color;
  };
  member_record = {};
  original_nine(object, item, &rect, &rect, RID{seed}, &margin1, &margin2, 2, 1, true, &color);
  check(nine_matches(member_record), "direct-nine-patch", "11 args, int32/bool/pointer stack tail");
  member_record = {};
  hook_record = {};
  g_object->nine_patch(item, rect, rect, RID{seed}, margin1, margin2, 2, 1, true, color);
  check(nine_matches(hook_record) && nine_matches(member_record), "hook-nine-patch",
        "11 args, natural-size stack packing and forwarding");
  member_record = {};
  hook_record = {};
  c = g_object->hfa(color, scale);
  const Color scaled{color.r * scale, color.g * scale, color.b * scale, color.a * scale};
  check(hook_record.self == object && member_record.self == object &&
        bits(hook_record.hfa, color) && bits(member_record.hfa, color) &&
        bits(hook_record.scale, scale) && bits(member_record.scale, scale) && bits(c, scaled),
        "hook-hfa", "Color by value in and out, forwarding");
  const void *arrays[] = {&rect, &color, &value, &margin1, &margin2, &args};
  member_record = {};
  hook_record = {};
  g_object->triangle_array(item, arrays[0], arrays[1], arrays[2], arrays[3], arrays[4], arrays[5],
                           RID{seed}, -12345);
  auto triangle_matches = [&](const Record &r) {
    return r.self == object && r.item.id == item.id && r.texture.id == seed &&
           r.count == -12345 && !std::memcmp(r.arrays, arrays, sizeof(arrays));
  };
  check(triangle_matches(hook_record) && triangle_matches(member_record), "hook-triangle-array",
        "pointer/RID/int32 stack tail and forwarding");
  __atomic_store_n(location, live, __ATOMIC_RELEASE);
  delete object;
  g_object = nullptr;
  std::free(storage);
  const int passed = total - static_cast<int>(failed.size());
  std::printf("abi_convention_probe: %d/%d ok\n", passed, total);
  if (!expected_failures.empty() && failed == expected_failures) {
    std::string names;
    for (const auto &name : failed) {
      if (!names.empty())
        names += ',';
      names += name;
    }
    std::printf("abi_convention_probe: sabotage detected (%s failed as "
                "expected); %d/%d others ok\n",
                names.c_str(), passed, passed);
  }
  return failed == expected_failures ? 0 : 1;
}
