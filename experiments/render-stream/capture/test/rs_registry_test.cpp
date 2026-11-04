// The late-arm resource registry (rs_registry.h, late-arm-registry-design.md LAR0): the off gate,
// kinds and families, erase on free and texture_replace, recreate, null creates, the per-family
// cap and overflow, the accounting identity registry-live-bound judges (entries == creates - frees
// - replaced - recreated, on every timeline row), the timeline, both fault knobs, the evidence
// shape, and concurrent creates and frees from several threads.
#include <cstdint>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

#include "rs_registry.h"

namespace {

int g_failures = 0;

void expect(bool ok, const std::string &what) {
  if (!ok) {
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
    ++g_failures;
  }
}

bool contains(const std::string &text, const std::string &needle) {
  return text.find(needle) != std::string::npos;
}

using grc::rs::RegistryFamily;
using grc::rs::RegistryFault;
using grc::rs::RegistryKind;

std::size_t fam(RegistryFamily f) { return static_cast<std::size_t>(f); }

// The identity on the final stats and on every timeline row.
bool identity_holds() {
  const grc::rs::RegistryStats st = grc::rs::registry_stats();
  std::uint64_t total = 0;
  for (const grc::rs::RegistryFamilyStats &f : st.family) {
    if (f.entries != f.creates - f.frees - f.replaced - f.recreated) {
      return false;
    }
    total += f.entries;
  }
  if (total != st.entries) {
    return false;
  }
  for (const grc::rs::RegistryRow &row : grc::rs::registry_timeline(nullptr)) {
    for (std::size_t i = 0; i < grc::rs::kRegistryFamilies; ++i) {
      if (row.entries[i] != row.creates[i] - row.frees[i]) {
        return false;
      }
    }
  }
  return true;
}

}  // namespace

int main() {
  using namespace grc::rs;

  // Kind -> family and names.
  expect(registry_family(RegistryKind::Texture2d) == RegistryFamily::Texture &&
             registry_family(RegistryKind::TexturePlaceholder) == RegistryFamily::Texture,
         "both texture kinds are the texture family");
  expect(std::string(registry_family_name(RegistryFamily::CanvasTexture)) == "canvas_texture",
         "family name");
  expect(std::string(registry_kind_name(RegistryKind::TexturePlaceholder)) ==
             "texture_placeholder",
         "kind name");
  expect(std::string(registry_fault_name(RegistryFault::KeepFreed)) == "registry-keep-freed",
         "fault name");

  // Off (GRC_ADOPT=off): the gate is closed and nothing is recorded even if a caller ignores it.
  registry_configure(false, RegistryFault::None);
  expect(!registry_on(), "off: gate closed");
  {
    const RegistryStats st = registry_stats();
    expect(!st.configured && !st.enabled && st.entries == 0, "off: empty, not configured");
  }
  // A fault without GRC_ADOPT=arm is dropped (the stream setup refuses that combination anyway).
  registry_configure(false, RegistryFault::KeepFreed);
  expect(!registry_on() && registry_stats().fault == RegistryFault::None, "off: fault dropped");

  // registry-off: configured (evidence written) but not recording.
  registry_configure(true, RegistryFault::Off);
  expect(!registry_on(), "registry-off: gate closed");
  expect(registry_stats().configured && !registry_stats().enabled, "registry-off: configured");
  expect(contains(registry_json(), "\"enabled\": false") &&
             contains(registry_json(), "\"fault\": \"registry-off\""),
         "registry-off: evidence says so");

  // On: kinds, frees, replace, recreate, null.
  registry_configure(true, RegistryFault::None);
  expect(registry_on(), "on: gate open");
  registry_note_create(0x100000001, RegistryKind::Texture2d);
  registry_note_create(0x100000002, RegistryKind::TexturePlaceholder);
  registry_note_create(0x100000003, RegistryKind::CanvasTexture);
  registry_note_create(0x100000004, RegistryKind::Mesh);
  registry_note_create(0x100000005, RegistryKind::Multimesh);
  registry_note_create(0x100000006, RegistryKind::Shader);
  registry_note_create(0x100000007, RegistryKind::Material);
  registry_note_create(0x100000008, RegistryKind::Particles);
  registry_note_create(0, RegistryKind::CanvasTexture);  // the dummy's RID() without the shim
  registry_frame(3);
  {
    RegistryKind k = RegistryKind::Mesh;
    expect(registry_lookup(0x100000002, &k) && k == RegistryKind::TexturePlaceholder,
           "lookup: placeholder kind");
    expect(registry_lookup(0x100000008, &k) && k == RegistryKind::Particles, "lookup: particles");
    expect(!registry_lookup(0x1, &k), "lookup: unknown RID");
    const RegistryStats st = registry_stats();
    expect(st.entries == 8 && st.family[fam(RegistryFamily::Texture)].entries == 2,
           "on: 8 entries, 2 textures");
    expect(st.family[fam(RegistryFamily::CanvasTexture)].null_creates == 1 &&
               st.family[fam(RegistryFamily::CanvasTexture)].entries == 1,
           "on: a null create is counted, not recorded");
  }
  // A free of an untracked RID (a canvas item) changes nothing; a tracked free erases.
  registry_note_free(0x200000001);
  registry_note_free(0x100000004);
  expect(!registry_lookup(0x100000004, nullptr), "free erases");
  expect(registry_stats().family[fam(RegistryFamily::Mesh)].frees == 1 &&
             registry_stats().family[fam(RegistryFamily::Mesh)].entries == 0 &&
             registry_stats().family[fam(RegistryFamily::Mesh)].peak == 1,
         "free: counted, entry gone, peak kept");
  // texture_replace(a, b): b goes (the engine frees it inside the call), a stays.
  registry_note_create(0x100000009, RegistryKind::Texture2d);
  registry_note_replace(0x100000001, 0x100000009);
  expect(registry_lookup(0x100000001, nullptr) && !registry_lookup(0x100000009, nullptr),
         "replace: by_texture erased, texture kept");
  expect(registry_stats().family[fam(RegistryFamily::Texture)].replaced == 1, "replace counted");
  // A placeholder replaced by a loaded texture takes the loaded one's kind.
  registry_note_create(0x10000000a, RegistryKind::Texture2d);
  registry_note_replace(0x100000002, 0x10000000a);
  {
    RegistryKind k = RegistryKind::Mesh;
    expect(registry_lookup(0x100000002, &k) && k == RegistryKind::Texture2d,
           "replace: a placeholder takes the by_texture's kind");
    expect(registry_stats().family[fam(RegistryFamily::Texture)].replaced == 2, "replace: twice");
  }
  registry_note_replace(0x100000001, 0x100000001);
  expect(registry_lookup(0x100000001, nullptr), "replace with itself keeps the texture");
  // A create of a value already present overwrites (last create wins), across families too.
  registry_note_create(0x100000006, RegistryKind::Material);
  {
    RegistryKind k = RegistryKind::Mesh;
    expect(registry_lookup(0x100000006, &k) && k == RegistryKind::Material, "recreate: new kind");
    const RegistryStats st = registry_stats();
    expect(st.family[fam(RegistryFamily::Shader)].recreated == 1 &&
               st.family[fam(RegistryFamily::Shader)].entries == 0 &&
               st.family[fam(RegistryFamily::Material)].entries == 2,
           "recreate: counted against the old family");
  }
  registry_frame(4);
  registry_frame(5);  // nothing changed: no row
  expect(identity_holds(), "identity holds");
  {
    std::uint64_t dropped = 9;
    const std::vector<RegistryRow> rows = registry_timeline(&dropped);
    expect(rows.size() == 2 && dropped == 0, "timeline: one row per changed frame");
    expect(rows.size() == 2 && rows[0].frame == 3 && rows[1].frame == 4, "timeline: frame labels");
    expect(rows.size() == 2 && rows[1].entries[fam(RegistryFamily::Mesh)] == 0 &&
               rows[1].frees[fam(RegistryFamily::Mesh)] == 1,
           "timeline: the free is in the second row");
  }
  {
    const std::string json = registry_json();
    expect(contains(json, "\"schema\": \"render-stream-registry/1\""), "json: schema");
    expect(contains(json, "\"canvas_texture\": {"), "json: per family");
    expect(contains(json, "\"family_order\""), "json: timeline columns");
    expect(contains(json, "\"null_creates\": 1"), "json: null creates");
    const RegistryStats st = registry_stats();
    expect(st.bytes_estimate >= st.entry_bytes && st.entry_bytes > 0, "bytes estimate");
  }

  // registry-keep-freed: the free hook keeps the entry, so the identity breaks -- exactly what
  // registry-live-bound must catch.
  registry_configure(true, RegistryFault::KeepFreed);
  registry_note_create(0x300000001, RegistryKind::Texture2d);
  registry_frame(1);
  registry_note_free(0x300000001);
  registry_frame(2);
  expect(registry_lookup(0x300000001, nullptr), "keep-freed: the entry survives its free");
  expect(registry_stats().family[fam(RegistryFamily::Texture)].frees == 1, "keep-freed: counted");
  expect(!identity_holds(), "keep-freed: the identity fails");
  {
    const std::vector<RegistryRow> rows = registry_timeline(nullptr);
    expect(rows.size() == 2 && rows[1].entries[0] == 1 && rows[1].creates[0] - rows[1].frees[0] == 0,
           "keep-freed: the second row shows entries 1 for creates - frees 0");
  }

  // Cap: past it the family stops recording and counts overflow; other families are unaffected,
  // and a free makes room again (no eviction).
  registry_configure(true, RegistryFault::None, 2);
  registry_note_create(0x400000001, RegistryKind::Mesh);
  registry_note_create(0x400000002, RegistryKind::Mesh);
  registry_note_create(0x400000003, RegistryKind::Mesh);
  registry_note_create(0x400000004, RegistryKind::Shader);
  {
    const RegistryStats st = registry_stats();
    expect(st.family[fam(RegistryFamily::Mesh)].entries == 2 &&
               st.family[fam(RegistryFamily::Mesh)].overflow == 1 &&
               !registry_lookup(0x400000003, nullptr),
           "cap: third mesh overflows");
    expect(st.family[fam(RegistryFamily::Shader)].entries == 1, "cap: per family");
  }
  registry_note_free(0x400000003);  // the overflowed RID: not registered, nothing to count
  registry_note_free(0x400000001);
  registry_note_create(0x400000005, RegistryKind::Mesh);
  expect(registry_lookup(0x400000005, nullptr), "cap: a free makes room");
  expect(identity_holds(), "cap: identity holds");

  // Timeline cap: rows past it are counted as dropped.
  registry_configure(true, RegistryFault::None);
  for (std::uint64_t i = 0; i < kRegistryTimelineCap + 5; ++i) {
    registry_note_create(0x500000000 + i + 1, RegistryKind::Texture2d);
    registry_frame(i + 1);
  }
  {
    std::uint64_t dropped = 0;
    expect(registry_timeline(&dropped).size() == kRegistryTimelineCap && dropped == 5,
           "timeline: capped, dropped counted");
  }

  // Threads (design R6): any thread may create and free; the identity and the live set hold.
  registry_configure(true, RegistryFault::None);
  {
    constexpr int kThreads = 4;
    constexpr std::uint64_t kPer = 20000;
    std::vector<std::thread> threads;
    for (int t = 0; t < kThreads; ++t) {
      threads.emplace_back([t] {
        const std::uint64_t base = (static_cast<std::uint64_t>(t) + 1) << 40;
        for (std::uint64_t i = 1; i <= kPer; ++i) {
          const RegistryKind kind = static_cast<RegistryKind>(i % 8);
          registry_note_create(base + i, kind);
          if (i % 2 == 0) {
            registry_note_free(base + i);
          }
        }
      });
    }
    std::thread framer([] {
      for (std::uint64_t f = 1; f <= 200; ++f) {
        registry_frame(f);
      }
    });
    for (std::thread &th : threads) {
      th.join();
    }
    framer.join();
    registry_frame(1000);
    const RegistryStats st = registry_stats();
    expect(st.entries == kThreads * kPer / 2, "threads: half the creates live");
    expect(identity_holds(), "threads: identity holds on every row");
  }

  // Reconfigure resets everything (a test-only path: the capture configures once).
  registry_configure(false, RegistryFault::None);
  expect(registry_stats().entries == 0 && registry_timeline(nullptr).empty(), "reset");

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_registry_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_registry_test: ok\n");
  return 0;
}
