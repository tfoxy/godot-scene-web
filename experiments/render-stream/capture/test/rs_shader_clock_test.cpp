// Resolve through a fake engine interface, then exercise the resident re-attach reset with the
// same cached binds. A separate process covers resolution that found a missing required bind.
#include "iface.h"
#include "rs_shader_clock.h"

#include <cstdio>
#include <cstring>

namespace {

bool missing_bind = false;
int bind_lookups = 0;
int getter_calls = 0;
int engine = 0;

const char *name_at(const void *ptr) {
  const char *name = nullptr;
  std::memcpy(&name, ptr, sizeof(name));
  return name;
}

void fake_name(GDExtensionUninitializedStringNamePtr dest, const char *name, GDExtensionBool) {
  std::memcpy(dest, &name, sizeof(name));
}

GDExtensionObjectPtr fake_singleton(GDExtensionConstStringNamePtr) { return &engine; }

GDExtensionMethodBindPtr fake_bind(GDExtensionConstStringNamePtr,
                                 GDExtensionConstStringNamePtr method, GDExtensionInt) {
  ++bind_lookups;
  const char *name = name_at(method);
  if (missing_bind && std::strcmp(name, "get_main_loop") == 0) return nullptr;
  return const_cast<char *>(name);
}

void fake_ptrcall(GDExtensionMethodBindPtr bind, GDExtensionObjectPtr,
                  const GDExtensionConstTypePtr *, GDExtensionTypePtr ret) {
  const auto *name = static_cast<const char *>(bind);
  if (std::strcmp(name, "get_setting_with_override") == 0) {
    const double rollover = 5.0;
    std::memcpy(ret, &rollover, sizeof(rollover));
  } else {
    ++getter_calls;
    // No main loop yet. The draw hook can advance independently of the frame callback.
    void *loop = nullptr;
    std::memcpy(ret, &loop, sizeof(loop));
  }
}

void fake_destroy(GDExtensionVariantPtr) {}
GDExtensionVariantType fake_type(GDExtensionConstVariantPtr) {
  return GDEXTENSION_VARIANT_TYPE_FLOAT;
}
void fake_float(GDExtensionUninitializedTypePtr dest, GDExtensionVariantPtr source) {
  std::memcpy(dest, source, sizeof(double));
}
GDExtensionTypeFromVariantConstructorFunc fake_constructor(GDExtensionVariantType) {
  return fake_float;
}

}  // namespace

int main(int argc, char **argv) {
  missing_bind = argc == 2 && std::strcmp(argv[1], "--unavailable") == 0;
  grc::g_iface.string_name_new_with_latin1_chars = fake_name;
  grc::g_iface.global_get_singleton = fake_singleton;
  grc::g_iface.classdb_get_method_bind = fake_bind;
  grc::g_iface.object_method_bind_ptrcall = fake_ptrcall;
  grc::g_iface.variant_destroy = fake_destroy;
  grc::g_iface.variant_get_type = fake_type;
  grc::g_iface.get_variant_to_type_constructor = fake_constructor;

  int checks = 0, failures = 0;
  auto check = [&](bool ok, const char *what) {
    ++checks;
    if (!ok) { ++failures; std::fprintf(stderr, "FAIL %s\n", what); }
  };
  using namespace grc::rs;
  auto &clock = shader_clock();
  shader_clock_set_draw_hooked(true);
  shader_clock_draw(2.0);  // Resolve once, including the project's non-default rollover.
  check(clock.rollover == 5.0, "initial resolution reads rollover 5");
  check(clock.available == !missing_bind, "initial resolution availability");
  const int lookups = bind_lookups;
  const std::string unavailable = clock.unavailable;

  clock.last_drawn = 7;
  clock.start_drawn = 3;
  clock.start_process_frames = 4;
  clock.start_draws = 2;
  clock.ticks = 8;
  clock.later_missed = 1;
  shader_clock_reset_attachment();
  check(clock.total == 0.0 && clock.draws == 0 && clock.advanced == 0 && clock.ticks == 0,
        "attachment counters reset");
  check(clock.last_drawn == -1 && clock.start_drawn == -1 && clock.start_process_frames == -1 &&
            clock.start_draws == 0 && clock.later_missed == 0 && !clock.draw_hooked,
        "attachment origin and hook state reset");
  check(clock.rollover == 5.0, "reattachment preserves resolved rollover");
  check(clock.available == !missing_bind && clock.unavailable == unavailable,
        "reattachment preserves resolved availability and reason");

  shader_clock_set_draw_hooked(true);
  shader_clock_draw(6.0);
  if (missing_bind) {
    check(clock.total == 0.0 && clock.advanced == 0, "unavailable clock never advances");
    check(!shader_clock_tick(), "unavailable clock rejects tick after reattachment");
    check(getter_calls == 0, "unavailable clock never calls unresolved getters");
  } else {
    check(clock.rollover == 5.0 && clock.total == 1.0,
          "reattachment wraps six seconds at the resolved five-second rollover");
    check(clock.draws == 1 && clock.advanced == 1, "new attachment counts only its own draw");
  }
  check(bind_lookups == lookups, "reattachment retains process-cached resolution");
  std::printf("rs_shader_clock_test%s: %d checks, %d failures\n",
              missing_bind ? " --unavailable" : "", checks, failures);
  return failures ? 1 : 0;
}
