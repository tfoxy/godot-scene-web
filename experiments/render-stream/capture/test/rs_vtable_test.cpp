// LS1 (live-swap-design.md D4, Q9 K1): the two shadow tables of vtable.h.
//
// A polymorphic fake stands in for RenderingServer. The checks: build fills the originals and
// publishes nothing; the standby table replaces only the standby slots and the armed table every
// slot; disarm restores the engine's table from either; publish refuses a vptr someone else wrote;
// then the K1 stress: 4 threads dispatch through the object while the main thread flips the vptr
// 10^6 times between the engine, standby and armed tables. Every call must reach the engine's
// function exactly once (a hook forwards), whichever table it went through.

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

#include "vtable.h"

namespace {

int g_failures = 0;

void expect(bool ok, const char *what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL: %s\n", what);
    ++g_failures;
  }
}

std::atomic<uint64_t> g_engine_a{0};
std::atomic<uint64_t> g_engine_b{0};
std::atomic<uint64_t> g_hook_a{0};
std::atomic<uint64_t> g_hook_b{0};

struct Fake {
  virtual int a(int x);
  virtual int b(int x);
};

__attribute__((noinline)) int Fake::a(int x) {
  g_engine_a.fetch_add(1, std::memory_order_relaxed);
  return x + 1;
}

__attribute__((noinline)) int Fake::b(int x) {
  g_engine_b.fetch_add(1, std::memory_order_relaxed);
  return x + 2;
}

using Fn = int (*)(Fake *, int);
void *g_orig_a = nullptr;
void *g_orig_b = nullptr;

int hook_a(Fake *self, int x) {
  g_hook_a.fetch_add(1, std::memory_order_relaxed);
  return reinterpret_cast<Fn>(g_orig_a)(self, x);
}

int hook_b(Fake *self, int x) {
  g_hook_b.fetch_add(1, std::memory_order_relaxed);
  return reinterpret_cast<Fn>(g_orig_b)(self, x);
}

// Through a volatile pointer, so every call loads the vptr (no devirtualisation).
Fake *volatile g_object = nullptr;

__attribute__((noinline)) int call_a(int x) { return g_object->a(x); }
__attribute__((noinline)) int call_b(int x) { return g_object->b(x); }

void **vptr_of(void *object) { return *static_cast<void ***>(object); }

void reset_counts() {
  g_engine_a = 0;
  g_engine_b = 0;
  g_hook_a = 0;
  g_hook_b = 0;
}

std::vector<grc::SlotReplacement> replacements() {
  // Slot 0 (a) is a standby slot, slot 1 (b) a hot one.
  grc::SlotReplacement ra{0, reinterpret_cast<void *>(&hook_a), &g_orig_a, true};
  grc::SlotReplacement rb{1, reinterpret_cast<void *>(&hook_b), &g_orig_b, false};
  return {ra, rb};
}

void test_tables() {
  Fake fake;
  g_object = &fake;
  void **engine = vptr_of(&fake);
  grc::ShadowVtable shadow;
  std::string error;
  expect(shadow.build(&fake, 2, replacements(), &error), "build");
  expect(vptr_of(&fake) == engine, "build publishes nothing");
  expect(g_orig_a == engine[0] && g_orig_b == engine[1], "build fills the originals");
  expect(shadow.armed_slots() == 2 && shadow.standby_slots() == 1, "slot counts");
  expect(!shadow.build(&fake, 2, replacements(), &error), "a second build refuses");

  reset_counts();
  call_a(1);
  call_b(1);
  expect(g_hook_a == 0 && g_hook_b == 0, "engine table: no hook runs");

  expect(shadow.publish(grc::ShadowVtable::Table::Standby), "publish standby");
  expect(vptr_of(&fake) == shadow.standby_address_point(), "standby published");
  reset_counts();
  expect(call_a(1) == 2 && call_b(1) == 3, "standby: results unchanged");
  expect(g_hook_a == 1 && g_hook_b == 0, "standby: only the standby slot is hooked");
  expect(g_engine_a == 1 && g_engine_b == 1, "standby: the engine sees each call once");

  expect(shadow.publish(grc::ShadowVtable::Table::Armed), "publish armed");
  reset_counts();
  call_a(1);
  call_b(1);
  expect(g_hook_a == 1 && g_hook_b == 1, "armed: every planned slot is hooked");
  expect(shadow.armed(), "armed()");

  bool was_shadow = false;
  bool restored = false;
  expect(shadow.disarm(&was_shadow, &restored) && was_shadow && restored, "disarm from armed");
  expect(vptr_of(&fake) == engine, "disarm restores the engine table");

  expect(shadow.publish(grc::ShadowVtable::Table::Standby), "re-publish standby after disarm");
  expect(shadow.disarm(&was_shadow, &restored) && was_shadow && restored, "disarm from standby");
  expect(vptr_of(&fake) == engine, "disarm from standby restores the engine table");
  expect(!shadow.disarm(&was_shadow, &restored) && !was_shadow, "disarm when unpatched is a no-op");

  // A vptr someone else wrote is never replaced, and never "restored" over.
  expect(shadow.publish(grc::ShadowVtable::Table::Standby), "publish standby again");
  static void *foreign[8] = {};
  void **saved = vptr_of(&fake);
  *static_cast<void ***>(static_cast<void *>(&fake)) = foreign + 2;
  expect(!shadow.publish(grc::ShadowVtable::Table::Armed), "publish refuses a foreign vptr");
  expect(!shadow.disarm(&was_shadow, &restored) && !was_shadow, "disarm leaves a foreign vptr");
  expect(vptr_of(&fake) == foreign + 2, "the foreign vptr is untouched");
  *static_cast<void ***>(static_cast<void *>(&fake)) = saved;
}

void test_flips() {
  Fake fake;
  g_object = &fake;
  grc::ShadowVtable shadow;
  std::string error;
  expect(shadow.build(&fake, 2, replacements(), &error), "stress build");
  reset_counts();
  std::atomic<bool> stop{false};
  std::atomic<uint64_t> calls{0};
  std::atomic<uint64_t> wrong{0};
  std::vector<std::thread> callers;
  for (int t = 0; t < 4; ++t) {
    callers.emplace_back([&, t] {
      uint64_t n = 0;
      while (!stop.load(std::memory_order_relaxed)) {
        const int x = static_cast<int>(n & 0xffff) + t;
        if (call_a(x) != x + 1 || call_b(x) != x + 2) {
          wrong.fetch_add(1, std::memory_order_relaxed);
        }
        ++n;
      }
      calls.fetch_add(n, std::memory_order_relaxed);
    });
  }
  const grc::ShadowVtable::Table order[3] = {grc::ShadowVtable::Table::Standby,
                                             grc::ShadowVtable::Table::Armed,
                                             grc::ShadowVtable::Table::Engine};
  bool all_published = true;
  for (int i = 0; i < 1000000; ++i) {
    all_published = shadow.publish(order[i % 3]) && all_published;
  }
  stop.store(true);
  for (std::thread &t : callers) {
    t.join();
  }
  bool was_shadow = false;
  bool restored = false;
  shadow.disarm(&was_shadow, &restored);
  expect(all_published, "every one of the 10^6 flips published");
  expect(wrong == 0, "every call returned the engine's result");
  expect(g_engine_a == calls && g_engine_b == calls, "every call reached the engine exactly once");
  expect(g_hook_a <= calls && g_hook_b <= g_hook_a + calls, "hook counts bounded by the calls");
  std::printf("rs_vtable: %llu calls per slot across 10^6 flips, a hooked %llu, b hooked %llu\n",
              static_cast<unsigned long long>(calls.load()),
              static_cast<unsigned long long>(g_hook_a.load()),
              static_cast<unsigned long long>(g_hook_b.load()));
}

}  // namespace

int main() {
  test_tables();
  test_flips();
  if (g_failures != 0) {
    std::fprintf(stderr, "rs_vtable: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_vtable: ok\n");
  return 0;
}
