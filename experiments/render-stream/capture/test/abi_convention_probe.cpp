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

GrcAbiProbe *volatile g_object = nullptr;
__attribute__((noinline)) GrcAbiProbe *make_object() { return new GrcAbiProbe; }

template <typename T> std::ptrdiff_t slot(T member) {
  struct MemberPointer {
    std::ptrdiff_t ptr, adjustment;
  } p{};
  static_assert(sizeof(member) == sizeof(p));
  std::memcpy(&p, &member, sizeof(p));
  return (p.ptr & 1) && p.adjustment == 0 ? (p.ptr - 1) / 8 : -1;
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
#else
  const char *abi = "sysv";
#endif
#if defined(GRC_PROBE_MSVC_ORDER)
  const char *variant = "msvc-order";
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
          slot(&GrcAbiProbe::get_xform) == 7,
      "slot-index", "2,3,4,5,6,7");
  original_rid = reinterpret_cast<RidFn>(live[2]);
  original_color = reinterpret_cast<ColorFn>(live[3]);
  original_vec = reinterpret_cast<VecFn>(live[4]);
  original_mixed = reinterpret_cast<MixedFn>(live[5]);
  original_rect = reinterpret_cast<RectFn>(live[6]);
  original_xform = reinterpret_cast<XformFn>(live[7]);
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

  // Two prefix words, two destructor slots and six method slots.
  auto **storage = static_cast<void **>(std::calloc(2 + 8, sizeof(void *)));
  if (!storage) {
    delete object;
    return 1;
  }
  std::memcpy(storage, live - 2, (2 + 8) * sizeof(void *));
  void **shadow = storage + 2;
  shadow[2] = reinterpret_cast<void *>(&hook_rid);
  shadow[3] = reinterpret_cast<void *>(&hook_color);
  shadow[4] = reinterpret_cast<void *>(&hook_vec);
  shadow[5] = reinterpret_cast<void *>(&hook_mixed);
  shadow[6] = reinterpret_cast<void *>(&hook_rect);
  shadow[7] = reinterpret_cast<void *>(&hook_xform);
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
