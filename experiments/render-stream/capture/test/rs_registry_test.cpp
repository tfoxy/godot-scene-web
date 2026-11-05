// The late-arm resource registry (rs_registry.h, late-arm-registry-design.md LAR0): the off gate,
// kinds and families, erase on free and texture_replace, recreate, null creates, the per-family
// cap and overflow, the accounting identity registry-live-bound judges (entries == creates - frees
// - replaced - recreated, on every timeline row), the timeline, both fault knobs, the evidence
// shape, concurrent creates and frees from several threads, and the payloads: (LAR1) CanvasTexture,
// (LAR2) multimesh, (LAR3) shader and material.
#include <cstdint>
#include <cstdio>
#include <memory>
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
    RegistryValue reentrant(new std::string("v"), [&released, kReentry](const std::string *p) {
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

  // Reconfigure resets everything (a test-only path: the capture configures once).
  registry_configure(false, RegistryFault::None);
  expect(registry_stats().entries == 0 && registry_timeline(nullptr).empty() &&
             registry_stats().canvas_payloads == 0 && !registry_canvas_texture(0x300000031, nullptr) &&
             registry_stats().multimesh_payloads == 0,
         "reset");

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_registry_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_registry_test: ok\n");
  return 0;
}
