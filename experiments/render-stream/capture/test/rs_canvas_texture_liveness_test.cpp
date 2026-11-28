#include "rs_canvas_texture_liveness.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

using namespace grc::rs;
namespace {
int checks = 0;
void check(bool ok, const char *name) {
  ++checks;
  if (!ok) { std::fprintf(stderr, "FAIL: %s\n", name); std::exit(1); }
}
int server_tag, device_tag, native_tag, format_tag, rd_texture_tag, rd_valid_tag;
struct Fake {
  std::uint64_t native = 0, rd_rid = 202;
  std::int64_t format = 5;
  std::uint8_t valid = 1;
  std::vector<GDExtensionMethodBindPtr> calls;
  CanvasTextureLiveCounts counts;
  CanvasTextureLiveBindings bindings{ptrcall, &server_tag, &device_tag,
      &native_tag, &format_tag, &rd_texture_tag, &rd_valid_tag};
  static Fake *active;
  static void ptrcall(GDExtensionMethodBindPtr bind, GDExtensionObjectPtr object,
                      const GDExtensionConstTypePtr *args, GDExtensionTypePtr out) {
    auto &f = *active;
    f.calls.push_back(bind);
    check(object == (bind == &rd_valid_tag ? &device_tag : &server_tag),
          "getter called on correct object");
    check(*static_cast<const std::uint64_t *>(args[0]) ==
              (bind == &rd_valid_tag ? f.rd_rid : 101), "getter receives correct RID");
    if (bind == &native_tag || bind == &rd_texture_tag)
      check(*static_cast<const std::uint8_t *>(args[1]) == 0,"getter keeps srgb false");
    if (bind == &native_tag) *static_cast<std::uint64_t *>(out) = f.native;
    else if (bind == &format_tag) *static_cast<std::int64_t *>(out) = f.format;
    else if (bind == &rd_texture_tag) *static_cast<std::uint64_t *>(out) = f.rd_rid;
    else if (bind == &rd_valid_tag) *static_cast<std::uint8_t *>(out) = f.valid;
    else check(false,"unexpected getter");
  }
  bool live() { active = this; return canvas_texture_is_live(bindings,101,counts); }
};
Fake *Fake::active = nullptr;
}
int main() {
  { Fake f;
    check(f.live(),"native zero plus valid RD texture is live");
    check(f.calls == std::vector<GDExtensionMethodBindPtr>{&native_tag,&rd_texture_tag,
              &rd_valid_tag,&format_tag},"RD proof precedes format check");
    check(f.counts.native==0 && f.counts.rd==1,"RD success counted"); }
  { Fake f; f.valid=0;
    check(!f.live(),"native zero plus invalid RD texture is not live");
    check(f.calls == std::vector<GDExtensionMethodBindPtr>{&native_tag,&rd_texture_tag,
              &rd_valid_tag},"invalid RD skips format");
    check(f.counts.native==0 && f.counts.rd==0,"invalid RD not counted"); }
  { Fake f; f.rd_rid=0;
    check(!f.live(),"null RD texture is not live");
    check(f.calls == std::vector<GDExtensionMethodBindPtr>{&native_tag,&rd_texture_tag},
          "null RD skips validity and format"); }
  for (int missing=0;missing<3;++missing) {
    Fake f;
    if (missing==0) f.bindings.device=nullptr;
    if (missing==1) f.bindings.rd_texture=nullptr;
    if (missing==2) f.bindings.rd_valid=nullptr;
    check(!f.live(),"missing device or RD binding fails closed");
    check(f.calls == std::vector<GDExtensionMethodBindPtr>{&native_tag},
          "missing RD prerequisites skip other getters");
    check(f.counts.native==0 && f.counts.rd==0,"missing RD proof not counted");
  }
  for (const auto format : {-1,0,38,39}) {
    Fake f; f.native=303; f.format=format; f.bindings.device=nullptr;
    f.bindings.rd_texture=f.bindings.rd_valid=nullptr;
    const bool expected=format>=0 && format<39;
    check(f.live()==expected,"native route keeps format bounds without RD bindings");
    check(f.calls == std::vector<GDExtensionMethodBindPtr>{&native_tag,&format_tag},
          "native route keeps getter order and skips RD");
    check(f.counts.native==std::uint64_t(expected) && f.counts.rd==0,
          "only successful native proof counted");
  }
  for (const auto format : {-1,0,38,39}) {
    Fake f; f.format=format;
    const bool expected=format>=0 && format<39;
    check(f.live()==expected,"RD route retains format bounds");
    check(f.counts.rd==std::uint64_t(expected) && f.counts.native==0,
          "only successful RD proof counted");
  }
  std::printf("%d passed, 0 failed\n", checks);
}
