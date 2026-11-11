// The late-arm resource registry (rs_registry.h): the off gate,
// kinds and families, erase on free and texture_replace, recreate, null creates, the per-family
// cap and overflow, the accounting identity registry-live-bound judges (entries == creates - frees
// - replaced - recreated, on every timeline row), the timeline, both fault knobs, the evidence
// shape, concurrent creates and frees from several threads, and the payloads: (LAR1) CanvasTexture,
// (LAR2) multimesh, (LAR3) shader and material.
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "rs_registry.h"

namespace {

int g_failures = 0;
int g_checks = 0;

void expect(bool ok, const std::string &what) {
  ++g_checks;
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


void texture_holds() {
  using namespace grc::rs;
  auto input = [](std::int64_t bytes = 16) {
    RegistryHoldInput in;
    in.image = std::make_shared<int>(7);
    in.bytes = bytes; in.width = 2; in.height = 2; in.format = 5; in.frame = 23;
    return in;
  };
  auto balanced = [] { expect(hold_balanced(registry_hold_stats()), "hold: balanced"); };
  auto drop_count = [](HoldDrop why) {
    return registry_hold_stats().dropped[static_cast<std::size_t>(why)];
  };
  auto reset = [] { registry_configure(true, RegistryFault::None); };
  auto create = [](std::uint64_t rid) {
    registry_note_texture_create(rid, {2, 2, 5, false, true}, false);
  };
  auto store = [&](std::uint64_t rid) {
    auto in = input();
    expect(registry_note_texture_update(rid, &in) == HoldSkip::None && !in.image,
           "hold: store consumes reference"); balanced();
  };
  reset(); create(1); store(1);
  RegistryHoldRef ref;
  RegistryTextureRecord record;
  expect(registry_hold(1, &ref) && ref.image && ref.rec.rid == 1 && ref.rec.seq == 1 &&
             ref.rec.frame == 23 && ref.rec.bytes == 16 && ref.rec.source == HoldSource::Update,
         "hold: copies reference and record");
  expect(registry_texture(1, &record) && record.held && record.updated && record.edited,
         "hold: record bits");
  const auto generation = registry_hold_generation();
  store(1);
  expect(drop_count(HoldDrop::Superseded) == 1 && registry_hold_generation() > generation,
         "hold: supersede and generation");
  expect(ref.rec.seq == 1 && registry_hold(1, &ref) && ref.rec.seq == 2,
         "hold: snapshot owns old sequence");
  ref = {};
  // Every hook refusal must erase a previous image, never leave stale content.
  for (std::size_t i = 1; i < static_cast<std::size_t>(HoldSkip::Count); ++i) {
    reset(); create(1); store(1);
    auto in = input(); in.pre = static_cast<HoldSkip>(i);
    expect(registry_note_texture_update(1, &in) == in.pre && in.image &&
               !registry_hold(1, nullptr) && drop_count(HoldDrop::Unheld) == 1 &&
               registry_hold_stats().skipped[i] == 1, "hold: pre skip drops old image");
    expect(registry_texture(1, &record) && !record.held, "hold: skip clears bit"); balanced();
  }
  reset();
  auto in = input();
  expect(registry_note_texture_update(99, &in) == HoldSkip::Unregistered,
         "hold: missing update"); balanced();
  registry_note_create(1, RegistryKind::Shader);
  expect(registry_note_texture_update(1, &in) == HoldSkip::Unregistered,
         "hold: other family update"); balanced();
  registry_note_create(2, RegistryKind::TexturePlaceholder);
  expect(registry_note_texture_update(2, &in) == HoldSkip::NotTexture2d,
         "hold: placeholder update"); balanced();
  for (int field = 0; field < 4; ++field) {
    reset(); create(1); store(1); in = input();
    if (field == 0) ++in.width;
    if (field == 1) ++in.height;
    if (field == 2) ++in.format;
    if (field == 3) in.mipmaps = true;
    expect(registry_note_texture_update(1, &in) == HoldSkip::ShapeMismatch &&
               !registry_hold(1, nullptr) && drop_count(HoldDrop::Unheld) == 1,
           "hold: mismatched facts drop old image"); balanced();
  }
  reset(); create(1); create(2); store(1); store(2);
  in = input(); in.source = HoldSource::Replace;
  expect(registry_note_replace(1, 2, &in) == HoldSkip::None && in.image &&
             !registry_hold(2, nullptr) && registry_hold(1, &ref) &&
             ref.rec.source == HoldSource::Replace && ref.rec.seq == 3 &&
             drop_count(HoldDrop::Superseded) == 1 && drop_count(HoldDrop::ReplacedAway) == 1 &&
             registry_hold_stats().taken.replace == 1, "hold: replace both held RIDs");
  ref = {}; balanced();
  in = input();
  expect(registry_note_replace(1, 1, &in) == HoldSkip::None && in.image &&
             registry_hold(1, nullptr), "hold: self replace unchanged"); balanced();
  expect(registry_note_replace(1, 99, &in) == HoldSkip::Unregistered &&
             !registry_hold(1, nullptr) && drop_count(HoldDrop::Unheld) == 1,
         "hold: unknown source unholds target"); balanced();
  reset(); create(2); store(2); in = input();
  expect(registry_note_replace(99, 2, &in) == HoldSkip::Unregistered &&
             !registry_hold(2, nullptr) && drop_count(HoldDrop::ReplacedAway) == 1 &&
             !registry_lookup(2, nullptr), "hold: unknown target retires source"); balanced();
  for (auto kind : {RegistryKind::Shader, RegistryKind::TexturePlaceholder}) {
    reset(); create(1); store(1); registry_note_create(2, kind); in = input();
    const auto expected = kind == RegistryKind::Shader ? HoldSkip::Unregistered : HoldSkip::NotTexture2d;
    expect(registry_note_replace(1, 2, &in) == expected && !registry_hold(1, nullptr) &&
               drop_count(HoldDrop::Unheld) == 1, "hold: invalid source kind"); balanced();
  }
  for (std::size_t i = 1; i < static_cast<std::size_t>(HoldSkip::Count); ++i) {
    reset(); create(1); create(2); store(1); in = input();
    in.pre = static_cast<HoldSkip>(i);
    expect(registry_note_replace(1, 2, &in) == in.pre && in.image &&
               !registry_hold(1, nullptr) && !registry_hold(2, nullptr) &&
               drop_count(HoldDrop::Unheld) == 1 && drop_count(HoldDrop::ReplacedAway) == 0,
           "hold: getter refusal retires target image"); balanced();
  }
  reset(); registry_note_create(1, RegistryKind::Texture2d); in = input();
  expect(registry_note_texture_update(1, &in) == HoldSkip::None,
         "hold: unknown creation facts accept current image"); balanced();
  reset(); create(1); create(2); store(1);
  registry_texture_set_released(2, true); in = input();
  expect(registry_note_replace(1, 2, &in) == HoldSkip::ReleasedSource &&
             !registry_hold(1, nullptr), "hold: released source"); balanced();
  for (auto fault : {RegistryFault::None, RegistryFault::KeepFreed}) {
    registry_configure(true, fault); create(1); store(1); registry_note_free(1);
    expect(!registry_hold(1, nullptr) && drop_count(HoldDrop::Freed) == 1,
           "hold: free also under keep-freed"); balanced();
  }
  for (bool texture_create : {false, true}) {
    reset(); create(1); store(1);
    if (texture_create) create(1); else registry_note_create(1, RegistryKind::Texture2d);
    expect(!registry_hold(1, nullptr) && drop_count(HoldDrop::Recreated) == 1,
           "hold: both recreate entry points"); balanced();
  }
  reset();
  // Fill the total cap, including a small final image, and replace that image at the boundary.
  for (std::uint64_t rid = 1; rid <= 65; ++rid) {
    registry_note_create(rid, RegistryKind::Texture2d); in = input(rid == 65 ? 64 : 65535);
    expect(registry_note_texture_update(rid, &in) == HoldSkip::None, "hold: cap fill"); balanced();
  }
  in = input(64);
  expect(registry_note_texture_update(65, &in) == HoldSkip::None,
         "hold: total subtracts previous image"); balanced();
  registry_note_create(66, RegistryKind::Texture2d); in = input(65);
  expect(registry_note_replace(65, 66, &in) == HoldSkip::OverTotalCap &&
             !registry_hold(65, nullptr), "hold: replace respects total cap"); balanced();
  in = input(64); registry_note_texture_update(65, &in);
  in = input(65);
  expect(registry_note_texture_update(65, &in) == HoldSkip::OverTotalCap &&
             !registry_hold(65, nullptr), "hold: over total drops previous image"); balanced();
  std::vector<HoldRecord> records;
  registry_hold_records(&records, 3);
  expect(records.size() == 3 && records[0].rid == 1 && records[1].rid == 2 && records[2].rid == 3,
         "hold: records sorted before cap");
  registry_hold_records(&records, 0); expect(records.empty(), "hold: zero record cap");
  expect(registry_holds_drop_all(HoldDrop::Fault) == 64 && registry_hold_stats().live.bytes == 0 &&
             drop_count(HoldDrop::Fault) == 64 && !registry_hold(1, nullptr), "hold: fault drop all");
  balanced();
  // Final destruction re-enters the registry; any destruction under its leaf lock deadlocks.
  for (int event = 0; event < 8; ++event) {
    reset(); create(1); create(2); bool destroyed = false;
    in = input(); in.image = RegistryValue(new int(9), [&](const int *p) {
      delete p; registry_lookup(1, nullptr); destroyed = true;
    });
    registry_note_texture_update(1, &in);
    if (event == 0) registry_note_free(1);
    if (event == 1) create(1);
    if (event == 2) { in = input(); registry_note_texture_update(1, &in); }
    if (event == 3) { in = input(); in.pre = HoldSkip::NoImage; registry_note_texture_update(1, &in); }
    if (event == 4) { in = input(); registry_note_replace(2, 1, &in); registry_note_free(2); }
    if (event == 5) registry_holds_drop_all(HoldDrop::Fault);
    if (event == 6) reset();
    if (event == 7) registry_holds_release();
    expect(destroyed, "hold: releases outside lock");
    if (event != 7) balanced();
  }
  reset(); create(1); create(2); store(1); store(2);
  bool output_destroyed = false;
  ref.image = RegistryValue(new int(4), [&](const int *p) {
    delete p; registry_lookup(1, nullptr); output_destroyed = true;
  });
  expect(registry_hold(1, &ref) && output_destroyed,
         "hold: replacing output releases outside lock");
  registry_note_free(1);
  expect(ref.image && ref.rec.rid == 1, "hold: copied reference outlives free");
  ref = {}; balanced();
  reset(); create(1); store(1); registry_holds_release();
  expect(!registry_hold(1, nullptr) && registry_texture(1, &record) && !record.held,
         "hold: shutdown clears side map and bit");
  reset();
}


void replace_held_source() {
  using namespace grc::rs;
  auto input = [](int marker, std::int64_t bytes = 16) {
    RegistryHoldInput in;
    in.image = std::make_shared<int>(marker);
    in.bytes = bytes; in.width = 2; in.height = 2; in.format = 5; in.frame = 31;
    return in;
  };
  auto create = [](std::uint64_t rid) { registry_note_create(rid, RegistryKind::Texture2d); };
  auto balanced = [] {
    const auto s = registry_hold_stats();
    expect(hold_balanced(s) && pending_balanced(s.pending), "held source: balanced");
  };
  for (bool offmain : {false, true}) {
    registry_configure(true, RegistryFault::None); create(1); create(2);
    auto in = input(1);
    registry_note_texture_update(1, &in);
    int released = 0;
    in = input(2);
    in.image = RegistryValue(new int(2), [&](const int *p) {
      delete p; registry_lookup(1, nullptr); ++released;
    });
    registry_note_texture_update(2, &in);
    in = input(3); const auto getter = in.image;
    if (offmain) { in.image.reset(); in.pre = HoldSkip::OffmainReplace; }
    expect(registry_note_replace(1, 2, &in) == HoldSkip::None,
           "held source: replace accepts updated source on any thread");
    RegistryHoldRef ref;
    expect(registry_hold(1, &ref) && *static_cast<const int *>(ref.image.get()) == 2,
           "held source: latest update wins over stale getter");
    expect(offmain ? !in.image : in.image == getter, "held source: getter stays in input");
    const auto s = registry_hold_stats();
    expect(!registry_hold(2, nullptr) && s.taken.replace == 1 &&
               s.dropped[static_cast<std::size_t>(HoldDrop::ReplacedAway)] == 1 &&
               s.dropped[static_cast<std::size_t>(HoldDrop::Superseded)] == 1 &&
               s.skipped[static_cast<std::size_t>(HoldSkip::OffmainReplace)] == 0,
           "held source: transfer accounting");
    ref = {};
    expect(released == 0, "held source: source stays alive until target free");
    registry_note_free(1);
    expect(released == 1, "held source: source released exactly once outside lock"); balanced();
  }
  registry_configure(true, RegistryFault::None); create(1); create(2);
  auto in = input(1); registry_note_pending(2, &in);
  in = input(2); registry_note_texture_update(2, &in);
  auto s = registry_hold_stats();
  expect(s.pending.live.entries == 0 && s.pending.live.bytes == 0 &&
             s.pending.dropped[static_cast<std::size_t>(PendingDrop::Updated)] == 1 &&
             registry_hold(2, nullptr), "held source: update cannot leave pending and held together");
  in = {}; in.pre = HoldSkip::OffmainReplace;
  expect(registry_note_replace(1, 2, &in) == HoldSkip::None &&
             registry_hold_stats().pending.moved == 0,
         "held source: updated pending source moves as hold"); balanced();

  registry_configure(true, RegistryFault::None);
  for (std::uint64_t rid = 1; rid <= 65; ++rid) {
    create(rid); in = input(2, rid == 65 ? 64 : 65535);
    registry_note_texture_update(rid, &in);
  }
  expect(registry_hold_stats().live.bytes == kHoldTotalMaxBytes, "held source: full cap setup");
  create(66); in = input(3, 65535);
  expect(registry_note_replace(66, 1, &in) == HoldSkip::None && in.image &&
             registry_hold(66, nullptr) && !registry_hold(1, nullptr),
         "held source: total cap credits retiring source bytes");
  s = registry_hold_stats();
  expect(s.live.bytes == kHoldTotalMaxBytes && s.peak.bytes == kHoldTotalMaxBytes &&
             s.skipped[static_cast<std::size_t>(HoldSkip::OverTotalCap)] == 0,
         "held source: transfer stays within cap including peak"); balanced();
  registry_configure(true, RegistryFault::None);
}

void pending_holds() {
  using namespace grc::rs;
  auto reset = [](RegistryFault fault = RegistryFault::None) { registry_configure(true, fault); };
  auto create = [](std::uint64_t rid) {
    registry_note_texture_create(rid, {2, 2, 5, false, true}, false);
  };
  auto input = [](std::int64_t bytes = 16) {
    RegistryHoldInput in;
    in.image = std::make_shared<int>(7);
    in.bytes = bytes; in.width = 2; in.height = 2; in.format = 5; in.frame = 23;
    return in;
  };
  auto balanced = [] {
    const auto s = registry_hold_stats();
    expect(hold_balanced(s) && pending_balanced(s.pending), "pending: balanced");
  };
  auto store = [&](std::uint64_t rid, std::int64_t bytes = 16) {
    auto in = input(bytes);
    expect(registry_note_pending(rid, &in) == HoldSkip::None && !in.image,
           "pending: stores reference"); balanced();
  };
  auto offmain = [] {
    RegistryHoldInput in; in.pre = HoldSkip::OffmainReplace; in.frame = 31; return in;
  };
  auto count = [](PendingDrop why) {
    return registry_hold_stats().pending.dropped[static_cast<std::size_t>(why)];
  };
  reset(); auto in = input();
  expect(registry_note_pending(1, &in) == HoldSkip::Unregistered && in.image,
         "pending: missing RID leaves input"); balanced();
  for (auto kind : {RegistryKind::Shader, RegistryKind::TexturePlaceholder}) {
    registry_note_create(1, kind);
    expect(registry_note_pending(1, &in) == HoldSkip::NotTexture2d,
           "pending: only Texture2d"); balanced();
  }
  create(1);
  for (auto skip : {HoldSkip::VramFormat, HoldSkip::NoImage, HoldSkip::SizeUnknown,
                    HoldSkip::OverTextureCap}) {
    in = input(); in.pre = skip;
    expect(registry_note_pending(1, &in) == skip && in.image &&
               registry_hold_stats().pending.skipped[static_cast<std::size_t>(skip)] == 1,
           "pending: hook refusal"); balanced();
  }
  reset(); create(1); create(2); store(2);
  in = offmain();
  expect(registry_note_replace(1, 2, &in) == HoldSkip::None, "pending: offmain move");
  RegistryHoldRef ref;
  auto st = registry_hold_stats();
  expect(registry_hold(1, &ref) && ref.rec.bytes == 16 && ref.rec.frame == 31 &&
             ref.rec.source == HoldSource::Replace && st.pending.moved == 1 &&
             st.pending.moved_bytes == 16 && st.pending.live.entries == 0 &&
             st.taken.replace == 1 && !registry_lookup(2, nullptr), "pending: move counters");
  ref = {}; balanced();
  create(2); in = offmain();
  expect(registry_note_replace(1, 2, &in) == HoldSkip::OffmainReplace && !registry_hold(1, nullptr),
         "pending: no pending offmain source unholds target"); balanced();
  reset(); create(1); create(2); store(1);
  in = input(); auto pending_image = in.image;
  registry_note_pending(2, &in); in = input(); auto getter_image = in.image;
  expect(registry_note_replace(1, 2, &in) == HoldSkip::None && in.image == getter_image &&
             registry_hold(1, &ref) && ref.image == pending_image &&
             count(PendingDrop::Replaced) == 1, "pending: source wins and target pending retires");
  ref = {}; balanced();
  reset(); create(1); store(1); in = input();
  expect(registry_note_texture_update(1, &in) == HoldSkip::None &&
             count(PendingDrop::Updated) == 1 && registry_hold(1, nullptr),
         "pending: update becomes hold"); balanced();
  for (auto fault : {RegistryFault::None, RegistryFault::KeepFreed}) {
    reset(fault); create(1); store(1); registry_note_free(1);
    expect(count(PendingDrop::Freed) == 1 && registry_hold_stats().pending.live.entries == 0,
           "pending: free including keep-freed"); balanced();
  }
  for (bool generic : {false, true}) {
    reset(); create(1); store(1);
    if (generic) registry_note_create(1, RegistryKind::Texture2d); else create(1);
    expect(count(PendingDrop::Recreated) == 1, "pending: recreate both entry points"); balanced();
  }
  for (int scenario = 0; scenario < 5; ++scenario) {
    reset(); create(1); create(2); store(1); store(2); in = offmain();
    if (scenario == 0) registry_note_replace(99, 2, &in);
    if (scenario == 1) registry_note_replace(1, 99, &in);
    if (scenario == 2) { registry_texture_set_released(2, true); registry_note_replace(1, 2, &in); }
    if (scenario == 3) { registry_note_create(1, RegistryKind::Shader); registry_note_replace(1, 2, &in); }
    if (scenario == 4) registry_note_replace(1, 1, &in);
    const auto p = registry_hold_stats().pending;
    expect(p.moved == 0 && p.live.entries == (scenario == 4 ? 2U : scenario == 2 || scenario == 3 ? 0U : 1U),
           "pending: refused and self replace lifetime"); balanced();
  }
  reset();
  for (std::uint64_t rid = 1; rid <= 17; ++rid) { create(rid); store(rid); }
  st = registry_hold_stats();
  expect(st.pending.evicted == 1 && st.pending.evicted_bytes == 16 && st.pending.live.entries == 16,
         "pending: seventeenth evicts oldest");
  create(100); in = offmain();
  expect(registry_note_replace(100, 1, &in) == HoldSkip::OffmainReplace, "pending: oldest was evicted");
  in = offmain(); expect(registry_note_replace(100, 2, &in) == HoldSkip::None,
                         "pending: second oldest survives"); balanced();
  reset();
  for (std::uint64_t rid = 1; rid <= 5; ++rid) { create(rid); store(rid, 65535); }
  st = registry_hold_stats();
  expect(st.pending.live.entries == 4 && st.pending.live.bytes == 262140 &&
             st.pending.evicted == 1 && st.pending.evicted_bytes == 65535,
         "pending: byte cap evicts oldest"); balanced();
  // A larger incoming image can require several evictions even below the entry cap.
  reset();
  for (std::uint64_t rid = 1; rid <= 8; ++rid) { create(rid); store(rid, 32768); }
  create(9); store(9, 65535);
  expect(registry_hold_stats().pending.evicted == 2 &&
             registry_hold_stats().pending.live.bytes == 262143, "pending: evicts until bytes fit");
  balanced();
  expect(registry_holds_drop_all(HoldDrop::Fault) == 0 &&
             registry_hold_stats().pending.live.entries == 7, "pending: arm fault leaves pending"); balanced();
  // Engine-reference destruction re-enters the registry on every retiring path.
  for (int event = 0; event < 8; ++event) {
    reset(); create(1); create(2); bool destroyed = false;
    in = input(); in.image = RegistryValue(new int(9), [&](const int *p) {
      delete p; registry_lookup(1, nullptr); destroyed = true;
    });
    registry_note_pending(1, &in);
    if (event == 0) registry_note_free(1);
    if (event == 1) create(1);
    if (event == 2) { in = input(); registry_note_texture_update(1, &in); }
    if (event == 3) { in = offmain(); registry_note_replace(1, 2, &in); }
    if (event == 4) { in = offmain(); registry_texture_set_released(1, true); registry_note_replace(2, 1, &in); }
    if (event == 5) { for (std::uint64_t rid = 2; rid <= 17; ++rid) { create(rid); store(rid); } }
    if (event == 6) reset();
    if (event == 7) registry_holds_release();
    expect(destroyed, "pending: releases outside lock");
    if (event != 7) balanced();
    else expect(registry_hold_stats().pending.live.entries == 0, "pending: shutdown clears slots");
  }
  reset();
  std::atomic<int> made{0}, destroyed{0}, ready{0};
  std::atomic<bool> go{false};
  constexpr int per_thread = 200;
  std::vector<std::thread> threads;
  for (int t = 0; t < 4; ++t) {
    threads.emplace_back([&, t] {
      ++ready; while (!go.load()) std::this_thread::yield();
      for (int i = 0; i < per_thread; ++i) {
        const auto rid = static_cast<std::uint64_t>(1000 + t * per_thread + i);
        create(rid); auto value = input(); ++made;
        value.image = RegistryValue(new int(9), [&](const int *p) {
          delete p; registry_lookup(1, nullptr); ++destroyed;
        });
        registry_note_pending(rid, &value);
      }
    });
  }
  while (ready.load() != 4) std::this_thread::yield();
  go = true;
  for (int i = 0; i < per_thread; ++i) {
    for (int t = 0; t < 4; ++t) {
      const auto rid = static_cast<std::uint64_t>(1000 + t * per_thread + i);
      create(1); auto source = offmain(); registry_note_replace(1, rid, &source);
      registry_note_free(rid); registry_note_free(1);
    }
  }
  for (auto &thread : threads) thread.join();
  balanced();
  reset();
  expect(made == 4 * per_thread && destroyed == made,
         "pending: concurrent stores, frees and replaces release every reference exactly once");
  balanced();
}

}  // namespace

int main() {
  using namespace grc::rs;

  texture_holds();
  replace_held_source();
  pending_holds();

  // Texture records preserve creation facts independently of content edits and paths.
  {
    registry_configure(true, RegistryFault::None);
    const RegistryTextureFacts facts{64, 32, 17, true, true};
    RegistryTextureRecord rec;
    registry_note_texture_create(11, facts, true);
    expect(registry_texture(11, &rec) && rec.rid == 11 && rec.facts.known &&
               rec.facts.width == 64 && rec.facts.height == 32 && rec.facts.format == 17 &&
               rec.facts.mipmaps && rec.released && !rec.edited && !rec.updated && !rec.path,
           "texture: fresh facts and released flag");
    registry_frame(1);
    int drops = 0;
    auto path = [&drops]() -> RegistryValue {
      return RegistryValue(new int(1), [&drops](const void *p) {
        delete static_cast<const int *>(p);
        ++drops;
        (void)registry_stats();  // Must be outside the leaf lock.
      });
    };
    registry_note_texture_path(11, path());
    auto latest = path();
    const void *latest_path = latest.get();
    registry_note_texture_path(11, std::move(latest));
    expect(drops == 1, "texture: last path wins, releases outside lock");
    registry_note_texture_update(11);
    registry_frame(2);
    expect(registry_timeline(nullptr).size() == 1, "texture: payload changes have no timeline row");
    expect(registry_texture(11, &rec) && rec.updated && rec.edited && rec.released && rec.path.get() == latest_path,
           "texture: update keeps facts, path and release, sets edited and updated");
    rec = {};
    expect(registry_texture_set_released(11, false) && registry_texture(11, &rec) &&
               !rec.released && rec.edited && rec.path,
           "texture: release toggle preserves other fields");
    rec = {};
    registry_note_texture_create(11, facts, false);
    expect(drops == 2 && registry_texture(11, &rec) && !rec.released && !rec.edited &&
               !rec.updated && !rec.path && rec.facts.known,
           "texture: recreate resets flags and drops path");
    registry_note_texture_path(11, path());
    registry_note_create(11, RegistryKind::TexturePlaceholder);
    expect(drops == 3 && registry_texture(11, &rec) && !rec.facts.known && !rec.path,
           "texture: placeholder recreate clears facts and path");
    registry_note_texture_path(11, path());
    registry_note_texture_create(12, facts, true);
    registry_note_texture_update(12);
    registry_note_texture_path(12, path());
    registry_note_replace(11, 12);
    expect(drops == 5 && !registry_texture(12, nullptr) && registry_texture(11, &rec) &&
               rec.kind == RegistryKind::Texture2d && rec.released && rec.edited && rec.updated &&
               rec.facts.known && rec.facts.mipmaps && !rec.path,
           "texture: replace inherits source facts/flags but neither path");
    registry_note_texture_create(12, {1, 1, 0, false, true}, false);
    registry_note_replace(11, 12);
    expect(registry_texture(11, &rec) && !rec.released && !rec.edited && rec.updated &&
               rec.facts.width == 1 && rec.facts.format == 0 && !rec.facts.mipmaps,
           "texture: replace clears destination flags absent from source");
    registry_note_texture_path(11, path());
    registry_note_replace(11, 11);
    expect(drops == 5 && registry_stats().texture_paths == 1, "texture: self replace keeps path");
    registry_note_free(11);
    expect(drops == 6 && !registry_texture(11, nullptr) && registry_stats().texture_paths == 0,
           "texture: free drops path outside lock");
    registry_note_create(13, RegistryKind::Mesh);
    registry_note_texture_path(13, path());
    registry_note_texture_path(99, path());
    expect(drops == 8 && !registry_texture(13, nullptr) &&
               !registry_texture_set_released(13, true) && !registry_texture_set_released(99, true),
           "texture: nontexture and unknown setters drop values and do nothing");
    registry_note_texture_create(14, facts, false);
    registry_note_texture_path(14, path());
    registry_note_create(14, RegistryKind::Material);
    expect(drops == 9 && !registry_texture(14, nullptr), "texture: other create drops path");
    registry_note_texture_create(0, facts, true);
    expect(registry_stats().family[fam(RegistryFamily::Texture)].null_creates == 1,
           "texture: null creates counted");
    expect(identity_holds(), "texture: mixed-create accounting identity");

    registry_configure(true, RegistryFault::None, 1);
    registry_note_texture_create(1, facts, true);
    registry_note_texture_create(2, facts, true);
    expect(!registry_texture(2, nullptr) && registry_stats().texture_facts == 1 &&
               registry_stats().texture_released == 1 &&
               registry_stats().family[fam(RegistryFamily::Texture)].overflow == 1,
           "texture: overflow records neither facts nor released creates");
    registry_note_texture_create(1, facts, false);
    expect(identity_holds(), "texture: recreate at cap is recorded");

    registry_configure(true, RegistryFault::KeepFreed);
    registry_note_texture_create(1, facts, true);
    registry_note_texture_path(1, path());
    registry_note_free(1);
    expect(registry_texture(1, &rec) && rec.path && rec.released &&
               registry_stats().texture_paths == 1, "texture: KeepFreed keeps path and facts");
    rec = {};
    registry_configure(true, RegistryFault::None);
    expect(drops == 10 && registry_stats().texture_paths == 0 &&
               registry_stats().texture_path_bytes == 0 && registry_stats().texture_facts == 0 &&
               registry_stats().texture_released == 0 && registry_stats().texture_path_sets == 0,
           "texture: configure resets counters and releases paths outside lock");

    for (const RegistryTextureFacts bad : {
             RegistryTextureFacts{0, 1, 0, false, true}, {1, 0, 0, false, true},
             {65536, 1, 0, false, true}, {1, 65536, 0, false, true},
             {1, 1, -1, false, true}, {1, 1, 39, false, true}, {1, 1, 0, false, false}}) {
      registry_note_texture_create(1, bad, true);
      expect(registry_texture(1, &rec) && !rec.facts.known && rec.released,
             "texture: invalid/unknown facts stay unknown, release is independent");
    }
    registry_note_texture_create(1, {65535, 65535, 38, true, true}, false);
    expect(registry_texture(1, &rec) && rec.facts.known && rec.facts.width == 65535 &&
               rec.facts.height == 65535 && rec.facts.format == 38, "texture: fact bounds inclusive");

    registry_configure(true, RegistryFault::None);
    registry_note_texture_create(1, facts, true);
    registry_note_create(2, RegistryKind::Mesh);
    registry_note_create(3, RegistryKind::TexturePlaceholder);
    registry_note_texture_path(1, path());
    registry_note_texture_path(3, path());
    std::vector<RegistryTextureRecord> records(1);
    registry_textures(&records);
    // At capacity 64 the Fibonacci homes of 1 and 3 are 39 and 54.
    expect(records.size() == 2 && records[0].rid == 1 && records[1].rid == 3 &&
               records[0].facts.known && records[0].released && records[0].path &&
               !records[1].facts.known && records[1].path,
           "texture: scan replaces output in slot order, includes placeholders only");
    const auto stats = registry_stats();
    expect(stats.texture_facts == 1 && stats.texture_released == 1 && stats.texture_paths == 2 &&
               stats.texture_path_sets == 2 && stats.texture_path_bytes == 64 * 24 &&
               stats.bytes_estimate == 64 * 16 + stats.texture_path_bytes,
           "texture: fact/path counters and side-map bytes");
    const auto json = registry_json();
    for (const char *field : {"texture_facts", "texture_released", "texture_paths",
                              "texture_path_sets", "texture_path_bytes"}) {
      expect(contains(json, std::string("\"") + field + "\":"), "texture: evidence field");
    }
    registry_configure(false, RegistryFault::None);
    expect(drops == 10, "texture: scans retain shared paths after configure");
    registry_textures(&records);
    expect(drops == 12 && records.empty(), "texture: replacing scan output releases outside lock");

    registry_configure(true, RegistryFault::None);
    registry_note_texture_create(1, facts, true);
    registry_note_texture_path(1, path());
    registry_texture(1, &rec);
    registry_note_free(1);
    registry_note_create(2, RegistryKind::TexturePlaceholder);
    expect(drops == 12 && registry_texture_set_released(2, true),
           "texture: snapshot owns freed path, placeholder accepts released flag");
    expect(registry_texture(2, &rec) && drops == 13 && rec.released && !rec.facts.known,
           "texture: replacing a record releases previous path outside lock");
    registry_note_texture_create(3, facts, true);
    registry_note_texture_path(3, path());
    registry_note_replace(99, 3);
    expect(drops == 14 && !registry_texture(99, nullptr) && !registry_texture(3, nullptr),
           "texture: replace into unknown RID erases source and its path");
    expect(identity_holds(), "texture: source erased into unknown target preserves identity");
  }

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
  // LAR6: the `updated` bit. A replaced texture is updated (b's data is not a's creation copy); a
  // texture_2d_update sets it on a texture only; a re-create clears it.
  {
    bool updated = false;
    expect(registry_lookup(0x100000002, nullptr, &updated) && updated,
           "updated: texture_replace sets the bit");
    registry_note_create(0x10000000b, RegistryKind::Texture2d);
    expect(registry_lookup(0x10000000b, nullptr, &updated) && !updated,
           "updated: a fresh create is clear");
    registry_note_texture_update(0x10000000b);
    expect(registry_lookup(0x10000000b, nullptr, &updated) && updated,
           "updated: texture_2d_update sets it");
    registry_note_create(0x10000000b, RegistryKind::Texture2d);
    expect(registry_lookup(0x10000000b, nullptr, &updated) && !updated,
           "updated: a re-create clears it");
    registry_note_texture_update(0x200000077);  // untracked: nothing recorded
    expect(!registry_lookup(0x200000077, nullptr), "updated: an untracked RID stays untracked");
    registry_note_free(0x10000000b);
  }
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

  // LAR1: the CanvasTexture payload (channels, filter, repeat), recorded for registered
  // CanvasTextures only, last writer wins, erased with the entry.
  registry_configure(true, RegistryFault::None);
  {
    constexpr std::uint64_t kCt = 0x300000001, kCt2 = 0x300000002, kTex = 0x300000010;
    constexpr std::uint64_t kNormal = 0x300000011, kPre = 0x300000020;
    registry_note_create(kTex, RegistryKind::Texture2d);
    registry_note_create(kCt, RegistryKind::CanvasTexture);
    RegistryCanvasTexture c;
    expect(registry_canvas_texture(kCt, &c) && !c.diffuse_set && !c.normal_set &&
               !c.specular_set && !c.filter_set && !c.repeat_set && c.diffuse == 0 &&
               c.filter == 0 && c.repeat == 0,
           "ctex: a fresh CanvasTexture is all default and unset");
    registry_note_canvas_channel(kCt, 0, kTex);
    registry_note_canvas_channel(kCt, 1, kNormal);
    registry_note_canvas_channel(kCt, 7, 0x9);  // not a channel: nothing recorded
    registry_note_canvas_filter(kCt, 1);
    registry_note_canvas_repeat(kCt, 2);
    registry_note_canvas_filter(kCt, 3);  // last writer wins
    expect(registry_canvas_texture(kCt, &c) && c.diffuse_set && c.diffuse == kTex &&
               c.normal_set && c.normal == kNormal && !c.specular_set && c.filter_set &&
               c.filter == 3 && c.repeat_set && c.repeat == 2,
           "ctex: channels, filter and repeat recorded, last writer wins");
    expect(registry_stats().canvas_payload_sets == 5 && registry_stats().canvas_payloads == 1,
           "ctex: five setter calls recorded, one payload");
    // A setter on a RID the registry never saw created (a pre-load CanvasTexture) records nothing:
    // no partial entry.
    registry_note_canvas_channel(kPre, 0, kTex);
    registry_note_canvas_filter(kTex, 1);  // a texture, not a CanvasTexture
    expect(!registry_canvas_texture(kPre, &c) && !registry_canvas_texture(kTex, &c),
           "ctex: no payload for an unregistered RID or another kind");
    // Recreated as a CanvasTexture: a fresh payload. Recreated as another kind: gone.
    registry_note_create(kCt, RegistryKind::CanvasTexture);
    expect(registry_canvas_texture(kCt, &c) && !c.diffuse_set && !c.filter_set,
           "ctex: a recreate starts fresh");
    registry_note_canvas_channel(kCt, 0, kTex);
    registry_note_create(kCt, RegistryKind::Mesh);
    expect(!registry_canvas_texture(kCt, &c), "ctex: recreated as a mesh, no payload");
    // A free erases the payload with the kind entry.
    registry_note_create(kCt2, RegistryKind::CanvasTexture);
    registry_note_canvas_channel(kCt2, 2, kTex);
    registry_note_free(kCt2);
    expect(!registry_canvas_texture(kCt2, &c) && registry_stats().canvas_payloads == 0,
           "ctex: a free erases the payload");
    const RegistryStats st = registry_stats();
    expect(st.canvas_payload_bytes > 0 && st.bytes_estimate >= st.canvas_payload_bytes,
           "ctex: the payload map is in bytes_estimate");
    expect(contains(registry_json(), "\"payloads\"") &&
               contains(registry_json(), "\"canvas_texture\": {"),
           "ctex: evidence has the payload block");
    expect(identity_holds(), "ctex: identity holds");
  }
  // registry-keep-freed keeps the payload too (the sabotage keeps the whole entry).
  registry_configure(true, RegistryFault::KeepFreed);
  {
    registry_note_create(0x300000031, RegistryKind::CanvasTexture);
    registry_note_canvas_channel(0x300000031, 0, 0x300000032);
    registry_note_free(0x300000031);
    RegistryCanvasTexture c;
    expect(registry_canvas_texture(0x300000031, &c) && c.diffuse == 0x300000032,
           "ctex keep-freed: the payload stays");
  }
  // registry-off: nothing recorded, so a deferred arm has no payload (LAR1's sabotage).
  registry_configure(true, RegistryFault::Off);
  expect(!registry_on(), "ctex registry-off: gate closed");

  // LAR2: the multimesh payload -- the allocation (GLES3's same-allocation rule), mesh, visible,
  // custom AABB and `edited` -- for registered multimeshes only, erased with the entry.
  registry_configure(true, RegistryFault::None);
  {
    constexpr std::uint64_t kMm = 0x400000001, kMm2 = 0x400000002, kMesh = 0x400000010;
    constexpr std::uint64_t kPre = 0x400000020;
    registry_note_create(kMm, RegistryKind::Multimesh);
    RegistryMultimesh m;
    expect(registry_multimesh(kMm, &m) && !m.allocated && m.instances == 0 && m.format == 0 &&
               !m.colors && !m.custom && !m.indirect && !m.edited && m.visible == -1 &&
               m.mesh == 0,
           "mm: a fresh multimesh is the engine's (nothing allocated, visible -1)");
    expect(registry_multimesh_stride(0, false, false) == 8 &&
               registry_multimesh_stride(0, false, true) == 12 &&
               registry_multimesh_stride(1, false, false) == 12 &&
               registry_multimesh_stride(1, true, true) == 20,
           "mm: the engine's strides (2d+custom and 3d are both 12)");
    registry_note_multimesh_allocate(kMm, 13, 0, false, true, false);
    registry_note_multimesh_mesh(kMm, kMesh);
    registry_note_multimesh_visible(kMm, 4);
    registry_note_multimesh_custom_aabb(kMm, {1, 2, 3, 4, 5, 6});
    expect(registry_multimesh(kMm, &m) && m.allocated && m.instances == 13 && m.format == 0 &&
               !m.colors && m.custom && m.mesh == kMesh && m.visible == 4 &&
               m.custom_aabb[0] == 1 && m.custom_aabb[5] == 6,
           "mm: allocation, mesh, visible and custom AABB recorded");
    registry_note_multimesh_visible(kMm, 14);  // > instances: the engine refuses it
    registry_note_multimesh_allocate(kMm, -1, 0, false, false, false);  // refused likewise
    registry_note_multimesh_allocate(kMm, 3, 2, false, false, false);   // no format 2
    expect(registry_multimesh(kMm, &m) && m.visible == 4 && m.instances == 13 && m.custom,
           "mm: calls the engine refuses record nothing");
    registry_note_multimesh_instance_edit(kMm);
    expect(registry_multimesh(kMm, &m) && m.edited, "mm: an instance setter sets edited");
    registry_note_multimesh_buffer(kMm, 13 * 12 - 1);  // the wrong size: the engine refuses it
    expect(registry_multimesh(kMm, &m) && m.edited, "mm: a refused buffer keeps edited");
    registry_note_multimesh_buffer(kMm, 13 * 12);
    expect(registry_multimesh(kMm, &m) && !m.edited, "mm: a valid buffer clears edited");
    registry_note_multimesh_instance_edit(kMm);
    registry_note_multimesh_allocate(kMm, 13, 0, false, true, true);  // same allocation
    expect(registry_multimesh(kMm, &m) && m.edited && m.indirect && m.visible == 4,
           "mm: the same allocation keeps the buffer (edited) but takes indirect");
    registry_note_multimesh_allocate(kMm, 3, 1, false, false, false);  // a new one, 3d
    expect(registry_multimesh(kMm, &m) && !m.edited && m.instances == 3 && m.format == 1 &&
               !m.custom && !m.indirect && m.visible == 3 && m.mesh == kMesh,
           "mm: a new allocation zeroes the buffer, clamps visible, keeps the mesh");
    expect(registry_stats().multimesh_payloads == 1 && registry_stats().multimesh_payload_sets == 10,
           "mm: one payload, ten recorded calls");
    // Unregistered (pre-load) or another kind: nothing recorded.
    registry_note_multimesh_allocate(kPre, 5, 0, false, false, false);
    registry_note_multimesh_allocate(kMesh, 5, 0, false, false, false);
    expect(!registry_multimesh(kPre, &m) && !registry_multimesh(kMesh, &m),
           "mm: no payload for an unregistered RID or another kind");
    // Recreated as another kind: gone. A free erases it.
    registry_note_create(kMm, RegistryKind::Mesh);
    expect(!registry_multimesh(kMm, &m), "mm: recreated as a mesh, no payload");
    registry_note_create(kMm2, RegistryKind::Multimesh);
    registry_note_multimesh_allocate(kMm2, 2, 0, false, false, false);
    registry_note_free(kMm2);
    expect(!registry_multimesh(kMm2, &m) && registry_stats().multimesh_payloads == 0,
           "mm: a free erases the payload");
    const RegistryStats st = registry_stats();
    expect(st.multimesh_payload_bytes > 0 && st.bytes_estimate >= st.multimesh_payload_bytes,
           "mm: the payload map is in bytes_estimate");
    expect(contains(registry_json(), "\"multimesh\": {"), "mm: evidence has the payload block");
    expect(identity_holds(), "mm: identity holds");
  }

  // LAR3: the shader payload (code, default textures) and the material payload (shader, params).
  {
    using grc::rs::RegistryMaterial;
    using grc::rs::RegistryShader;
    using grc::rs::RegistryStats;
    using grc::rs::RegistryValue;
    using namespace grc::rs;
    registry_configure(true, RegistryFault::None);
    constexpr std::uint64_t kSh = 0x500000001, kSh2 = 0x500000002, kMat = 0x500000010;
    constexpr std::uint64_t kMat2 = 0x500000011, kTex = 0x500000020, kPre = 0x500000030;
    constexpr std::uint64_t kReentry = 0x500000040;
    auto text = [](const char *t) -> RegistryValue { return std::make_shared<std::string>(t); };
    auto str = [](const RegistryValue &v) {
      return v != nullptr ? *static_cast<const std::string *>(v.get()) : std::string("<null>");
    };
    registry_note_create(kSh, RegistryKind::Shader);
    RegistryShader sh;
    expect(registry_shader(kSh, &sh) && sh.code == nullptr && sh.defaults.empty(),
           "sh: a fresh shader_create has no code");
    registry_note_shader_code(kSh, text("shader_type canvas_item; // a"));
    registry_note_shader_code(kSh, text("shader_type canvas_item; // b"));
    expect(registry_shader(kSh, &sh) && str(sh.code) == "shader_type canvas_item; // b",
           "sh: the last code wins");
    registry_note_shader_default_texture(kSh, "pal", kTex, 0);
    registry_note_shader_default_texture(kSh, "pal", kTex + 1, 0);
    registry_note_shader_default_texture(kSh, "pal", kTex, 1);
    registry_note_shader_default_texture(kSh, "noise", kTex, 0);
    registry_note_shader_default_texture(kSh, "noise", 0, 0);  // RID(): erased
    expect(registry_shader(kSh, &sh) && sh.defaults.size() == 2 && sh.defaults[0].name == "pal" &&
               sh.defaults[0].index == 0 && sh.defaults[0].texture == kTex + 1 &&
               sh.defaults[1].index == 1 && sh.defaults[1].texture == kTex,
           "sh: default textures by (name, index), last wins, RID() erases");
    registry_note_shader_code(kPre, text("x"));
    registry_note_shader_default_texture(kPre, "pal", kTex, 0);
    expect(!registry_shader(kPre, &sh) && !registry_shader(kTex, &sh),
           "sh: no payload for an unregistered RID");

    registry_note_create(kMat, RegistryKind::Material);
    RegistryMaterial mat;
    expect(registry_material(kMat, &mat) && mat.shader == 0 && mat.params.empty(),
           "mat: a fresh material has no shader and no parameters");
    registry_note_material_shader(kMat, kSh);
    registry_note_material_param(kMat, "tint", text("red"));
    registry_note_material_param(kMat, "gain", text("0.5"));
    registry_note_material_param(kMat, "tint", text("blue"));
    expect(registry_material(kMat, &mat) && mat.shader == kSh && mat.params.size() == 2 &&
               mat.params[0].name == "tint" && str(mat.params[0].value) == "blue" &&
               mat.params[1].name == "gain",
           "mat: shader and parameters, last value per name, first-set order");
    registry_note_material_param(kMat, "gain", nullptr);  // NIL or RID(): erased
    expect(registry_material(kMat, &mat) && mat.params.size() == 1 &&
               registry_stats().material_params == 1,
           "mat: a null value erases the parameter");
    registry_note_material_shader(kMat, 0);
    expect(registry_material(kMat, &mat) && mat.shader == 0, "mat: material_set_shader(RID())");
    registry_note_material_param(kPre, "tint", text("x"));
    registry_note_material_shader(kPre, kSh);
    expect(!registry_material(kPre, &mat), "mat: no payload for an unregistered RID");

    // A held value outlives its entry for whoever copied it, and the registry releases values
    // outside its lock: a release that re-enters the registry (a Variant whose Object's free
    // reaches the free hook) must not deadlock.
    registry_note_create(kReentry, RegistryKind::Texture2d);
    bool released = false;
    RegistryValue reentrant(new std::string("v"), [&released](const std::string *p) {
      grc::rs::registry_note_free(kReentry);
      released = true;
      delete p;
    });
    registry_note_create(kMat2, RegistryKind::Material);
    registry_note_material_param(kMat2, "obj", std::move(reentrant));
    RegistryMaterial copy;
    expect(registry_material(kMat2, &copy) && copy.params.size() == 1, "mat: a copy shares values");
    registry_note_free(kMat2);
    expect(!released && !registry_material(kMat2, &mat), "mat: the copy keeps the value alive");
    copy = RegistryMaterial();
    expect(released && !registry_lookup(kReentry, nullptr),
           "mat: released outside the lock (its re-entrant free ran)");

    // Recreated as another kind, or freed: the payload goes.
    registry_note_create(kSh2, RegistryKind::Shader);
    registry_note_shader_code(kSh2, text("y"));
    registry_note_create(kSh2, RegistryKind::Mesh);
    expect(!registry_shader(kSh2, &sh), "sh: recreated as a mesh, no payload");
    registry_note_free(kSh);
    expect(!registry_shader(kSh, &sh) && registry_stats().shader_payloads == 0,
           "sh: a free erases the payload");
    const RegistryStats st = registry_stats();
    expect(st.material_payloads == 1 && st.material_payload_sets == 7 && st.shader_payload_sets == 8,
           "mat/sh: payload counts and recorded calls");
    expect(st.shader_payload_bytes > 0 && st.material_payload_bytes > 0 &&
               st.bytes_estimate >= st.shader_payload_bytes + st.material_payload_bytes,
           "mat/sh: the payload maps are in bytes_estimate");
    const std::string json = registry_json();
    expect(contains(json, "\"shader\": {") && contains(json, "\"material\": {") &&
               contains(json, "\"params\": 1"),
           "mat/sh: evidence has both payload blocks");
    expect(identity_holds(), "mat/sh: identity holds");

    // registry-skip-params (LAR3's sabotage): records the shader binding but no parameter.
    registry_configure(true, RegistryFault::SkipParams);
    expect(registry_on() && std::string(registry_fault_name(RegistryFault::SkipParams)) ==
                                "registry-skip-params",
           "skip-params: the registry still records");
    registry_note_create(kMat, RegistryKind::Material);
    registry_note_material_shader(kMat, kSh);
    registry_note_material_param(kMat, "tint", text("red"));
    expect(registry_material(kMat, &mat) && mat.shader == kSh && mat.params.empty(),
           "skip-params: no parameter recorded");
  }

  // LS0: interned parameter names and the latest value stored in place. A name is one immortal
  // string known by its StringName identity (key); a value is stored over the previous one only
  // when the registry alone holds it and the hook's overwrite accepts it.
  {
    using namespace grc::rs;
    registry_configure(true, RegistryFault::None);
    constexpr std::uint64_t kMat = 0x600000010, kMat2 = 0x600000011, kGone = 0x600000099;
    constexpr std::uintptr_t kKeyTint = 0x7000, kKeyGain = 0x7008;
    registry_note_create(kMat, RegistryKind::Material);
    registry_note_create(kMat2, RegistryKind::Material);
    auto num = [](int v) -> RegistryValue { return std::make_shared<int>(v); };
    auto val = [](const RegistryValue &v) { return v != nullptr ? *static_cast<const int *>(v.get()) : -1; };
    int overwrites = 0;
    static int *overwrite_count = nullptr;
    overwrite_count = &overwrites;
    RegistryOverwrite store = [](const void *held, const void *variant) {
      *const_cast<int *>(static_cast<const int *>(held)) = *static_cast<const int *>(variant);
      ++*overwrite_count;
      return true;
    };
    RegistryOverwrite refuse_store = [](const void *, const void *) { return false; };

    expect(!registry_name_find(kKeyTint) && !registry_name_find(0), "names: an unseen key is empty");
    int nine = 9;
    RegistryName name;
    expect(registry_note_param_fast(kMat, kKeyTint, &nine, store, &name) == RegistryParamFast::NeedName,
           "names: an unseen key asks for its name");
    const RegistryName tint = registry_name_intern(kKeyTint, "tint", std::make_shared<int>(0));
    expect(tint == "tint" && registry_name_find(kKeyTint).same(tint), "names: a key finds its name");
    expect(registry_name_intern(0, "gain", nullptr) == "gain" && !registry_name_find(0),
           "names: no key or no keepalive caches nothing");
    expect(registry_name_intern(kKeyGain, "gain", std::make_shared<int>(0)) == "gain" &&
               registry_name_find(kKeyGain).same(registry_name_intern(0, "gain", nullptr)),
           "names: one text, one string");
    expect(registry_name_intern(kKeyTint, "tint", nullptr).same(tint), "names: interning is idempotent");

    expect(registry_note_param_fast(kMat, kKeyTint, &nine, store, &name) == RegistryParamFast::NeedValue &&
               name.same(tint),
           "fast: a new parameter needs a value");
    registry_note_material_param(kMat, name, num(1));
    expect(registry_note_param_fast(kGone, kKeyTint, &nine, store, &name) == RegistryParamFast::Recorded,
           "fast: an unknown material records nothing");
    expect(registry_note_param_fast(kMat, kKeyTint, &nine, refuse_store, &name) == RegistryParamFast::NeedValue,
           "fast: an overwrite the hook refuses falls back to a new value");
    expect(registry_note_param_fast(kMat, kKeyTint, &nine, store, &name) == RegistryParamFast::Recorded &&
               overwrites == 1,
           "fast: an unshared value is stored over in place");
    RegistryMaterial mat;
    expect(registry_material(kMat, &mat) && mat.params.size() == 1 && val(mat.params[0].value) == 9 &&
               mat.params[0].name.same(tint),
           "fast: the stored value is the latest");
    int eight = 8;
    expect(registry_note_param_fast(kMat, kKeyTint, &eight, store, &name) == RegistryParamFast::NeedValue &&
               overwrites == 1 && val(mat.params[0].value) == 9,
           "fast: a value a reader holds is not touched");
    registry_note_material_param(kMat, name, num(8));
    expect(val(mat.params[0].value) == 9, "fast: the reader keeps the value it copied");
    mat = RegistryMaterial();
    expect(registry_material(kMat, &mat) && val(mat.params[0].value) == 8 &&
               registry_stats().material_params == 1,
           "fast: the replacement is the latest value, one parameter");
    registry_note_material_param(kMat, tint, nullptr);
    expect(registry_material(kMat, &mat) && mat.params.empty() && registry_stats().material_params == 0,
           "names: a null value erases by name");
    registry_note_material_param(kMat2, "tint", num(5));
    expect(registry_material(kMat2, &mat) && mat.params[0].name.same(tint),
           "names: the by-text entry point lands on the same interned name");

    registry_configure(true, RegistryFault::SkipParams);
    registry_note_create(kMat, RegistryKind::Material);
    expect(registry_note_param_fast(kMat, kKeyTint, &nine, store, &name) == RegistryParamFast::Recorded &&
               registry_material(kMat, &mat) && mat.params.empty(),
           "fast: registry-skip-params records nothing");

    registry_names_release();
    expect(!registry_name_find(kKeyTint), "names: release forgets the keys");
    expect(registry_name_intern(kKeyTint, "tint", std::make_shared<int>(0)).same(tint),
           "names: the interned text survives a release");
    registry_configure(true, RegistryFault::None);
  }

  // LAR5: the particles payload -- every setter the mirror taps, the last writer winning, the
  // engine's refusals followed; a fresh emitter is GLES3's; erased with the kind entry.
  {
    registry_configure(true, RegistryFault::None);
    constexpr std::uint64_t kPt = 0x500000001, kPre = 0x500000002, kMesh = 0x500000010;
    registry_note_create(kPt, RegistryKind::Particles);
    RegistryParticles p;
    expect(registry_particles(kPt, &p) && !p.mode_2d && p.fixed_fps == 30 && p.interpolate &&
               p.floats == kRegistryParticleDefaults && p.passes.empty() && p.poses.empty(),
           "pt: a fresh emitter is GLES3's");
    using R = RegistryParticlesOp;
    registry_note_particles(kPt, R::Mode, 0, 0, nullptr, 0);
    registry_note_particles(kPt, R::Amount, 9, 0, nullptr, 0);
    registry_note_particles(kPt, R::Amount, 12, 0, nullptr, 0);  // the last writer wins
    registry_note_particles(kPt, R::Seed, 0xfffffffe, 0, nullptr, 0);
    const float xform[12] = {1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 0};
    registry_note_particles(kPt, R::Floats, 16, 0, xform, 12);
    registry_note_particles(kPt, R::Floats, 30, 0, xform, 2);  // past slot 30: refused
    const float len = 0.5f;
    registry_note_particles(kPt, R::Trails, 1, 0, &len, 1);
    const std::vector<float> poses(25, 2.0f);  // 2 poses and a stray float
    registry_note_particles(kPt, R::TrailBindPoses, 0, 0, poses.data(), poses.size());
    registry_note_particles(kPt, R::DrawPasses, 2, 0, nullptr, 0);
    registry_note_particles(kPt, R::DrawPassMesh, 1, kMesh, nullptr, 0);
    registry_note_particles(kPt, R::DrawPassMesh, 2, kMesh, nullptr, 0);  // out of range
    registry_note_particles(kPt, R::DrawPasses, -1, 0, nullptr, 0);        // refused
    registry_note_particles(kPt, R::ProcessMaterial, 0, 0x77, nullptr, 0);
    registry_note_particles(kPt, R::Subemitter, 0, 0x78, nullptr, 0);
    registry_note_particles(kPre, R::Amount, 9, 0, nullptr, 0);  // pre-load: nothing
    expect(registry_particles(kPt, &p) && p.mode_2d && p.amount == 12 && p.seed == 0xfffffffeu &&
               p.floats[25] == 5.0f && p.floats[26] == 6.0f && p.floats[30] == 0.0f &&
               p.trails && p.floats[7] == 0.5f && p.poses.size() == 24 &&
               p.passes == std::vector<std::uint64_t>({0, kMesh}) && p.process_material == 0x77 &&
               p.subemitter == 0x78,
           "pt: the setters recorded, last writer wins, refusals followed");
    expect(!registry_particles(kPre, nullptr), "pt: a pre-load emitter has no record");
    {
      const RegistryStats st = registry_stats();
      expect(st.particles_payloads == 1 && st.particles_payload_sets == 14 &&
                 st.particles_payload_bytes >= 26 * 8,
             "pt: stats count the payload, its sets and its vectors");
      expect(contains(registry_json(), "\"particles\": {"), "pt: evidence has the block");
    }
    registry_note_free(kPt);
    expect(!registry_particles(kPt, nullptr) && registry_stats().particles_payloads == 0,
           "pt: the free erases the payload");
    expect(identity_holds(), "pt: identity holds");

    // registry-skip-particles (LAR5's sabotage): the kind is recorded, no setter is.
    registry_configure(true, RegistryFault::SkipParticles);
    expect(registry_on() && std::string(registry_fault_name(RegistryFault::SkipParticles)) ==
                                "registry-skip-particles",
           "skip-particles: the registry still records");
    registry_note_create(kPt, RegistryKind::Particles);
    registry_note_particles(kPt, R::Amount, 9, 0, nullptr, 0);
    expect(registry_particles(kPt, &p) && p.amount == 0, "skip-particles: no setter recorded");
  }

  // Reconfigure resets everything (a test-only path: the capture configures once).
  registry_configure(false, RegistryFault::None);
  expect(registry_stats().entries == 0 && registry_timeline(nullptr).empty() &&
             registry_stats().canvas_payloads == 0 && !registry_canvas_texture(0x300000031, nullptr) &&
             registry_stats().multimesh_payloads == 0 && registry_stats().particles_payloads == 0,
         "reset");

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_registry_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_registry_test: %d checks, 0 failures\n", g_checks);
  return 0;
}
