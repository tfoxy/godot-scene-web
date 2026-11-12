// The engine-free half of the arm-time adoption pass (src/rs_adopt.*).
// Each scene is driven twice: once as a capture armed at birth sees it (the hooks' calls,
// in the order CanvasItem / CanvasLayer issue them on entering the tree) and once as the
// adoption walk's AdoptPlan; the two mirrors' snapshots must agree on every field but `origin`.
// Also: the three walk sabotages, the strict/skip handling of a canvas the plan leaves out, the
// mirror's configurable caps, and the seam's refusal without an engine.
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <map>
#include <memory>
#include <random>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "fake_godot_iface.h"
#include "hooks.h"
#include "rs_adopt.h"
#include "rs_evict.h"
#include "rs_json_lite.h"
#include "rs_registry.h"
#include "rs_mirror.h"
#include "rs_resource_log.h"
#include "rs_shader_payload.h"
#include "rs_texture_payload.h"
#include "rs_texture_worker.h"

namespace {

using grc::rs::AdoptedItem;
using grc::rs::AdoptedLayer;
using grc::rs::AdoptPlan;
using grc::rs::AdoptSabotage;
using grc::rs::AdoptStats;
using grc::rs::Mirror;
using grc::rs2::CanvasState;
using grc::rs2::Color4;
using grc::rs2::ItemState;
using grc::rs2::Origin;
using grc::rs2::Snapshot;
using grc::rs2::Xform;

int g_failures = 0;
int g_checks = 0;

void check(bool condition, const std::string &what) {
  ++g_checks;
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
    ++g_failures;
  }
}

constexpr uint64_t kRootViewport = 0x1000;
constexpr uint64_t kRootCanvas = 0x2000;
constexpr uint64_t kLayerCanvas = 0x3000;
constexpr Xform kIdentity = {1, 0, 0, 1, 0, 0};
constexpr Xform kMoved = {1, 0, 0, 1, 20, 30};
constexpr Xform kLayerXform = {1, 0, 0, 1, 10, 200};
constexpr Color4 kTint = {1.0f, 0.8f, 0.8f, 1.0f};
constexpr Color4 kHalf = {1.0f, 1.0f, 1.0f, 0.6f};
constexpr Color4 kLayerTint = {1.0f, 1.0f, 0.6f, 1.0f};

void start(Mirror *m, grc::rs2::UnknownItemPolicy policy) {
  m->reset();
  m->set_unknown_item_policy(policy);
  m->set_root(kRootViewport, kRootCanvas, kIdentity);
}

// The scene: World (Node2D, moved, tinted) > Box (self-modulate 0.6 alpha, z 1) and Behind
// (show_behind_parent, index 1); Top (top level under World, canvas group of the root canvas);
// a CanvasLayer (layer 2, offset) with a CanvasModulate and LayerBox (filter nearest, hidden).
struct Rids {
  uint64_t world = 0x10, box = 0x11, behind = 0x12, top = 0x13, modulate = 0x14, layer_box = 0x15;
};

// What a capture armed at birth records: creation in construction order, then each node's
// NOTIFICATION_ENTER_TREE calls, the deferred child draw index, the deferred top-level raise.
void drive_born(Mirror *m, const Rids &r, uint64_t frame) {
  for (uint64_t rid : {r.world, r.box, r.behind, r.top}) m->canvas_item_create(rid, frame);
  m->canvas_create(kLayerCanvas, frame);
  for (uint64_t rid : {r.modulate, r.layer_box}) m->canvas_item_create(rid, frame);
  // setters run on the instanced nodes before they enter the tree
  m->set_transform(r.world, kMoved, frame);
  m->set_modulate(r.world, kTint, frame);
  m->set_self_modulate(r.box, kHalf, frame);
  m->set_z_index(r.box, 1, frame);
  m->set_behind(r.behind, true, frame);
  // CG1: World clips its children (clip_children_mode only: the RS defaults), Behind is a
  // CanvasGroup (its constructor's transparent group), Top a BackBufferCopy in rect mode.
  m->set_canvas_group_mode(r.world, 1, 5.0f, false, 0.0f, false, frame);
  m->set_canvas_group_mode(r.behind, 3, 10.0f, true, 10.0f, false, frame);
  m->set_copy_to_backbuffer(r.top, true, {-100.0f, -100.0f, 200.0f, 200.0f}, frame);
  // enter tree, pre-order
  m->set_parent(r.world, kRootCanvas, frame);
  m->set_visibility_layer(r.world, 1, frame);
  m->set_visible(r.world, true, frame);
  m->set_texture_filter(r.world, 0, frame);
  m->set_texture_repeat(r.world, 0, frame);
  for (uint64_t rid : {r.box, r.behind}) {
    m->set_parent(rid, r.world, frame);
    m->set_visibility_layer(rid, 1, frame);
    m->set_visible(rid, true, frame);
    m->set_texture_filter(rid, 0, frame);
    m->set_texture_repeat(rid, 0, frame);
  }
  m->set_parent(r.top, kRootCanvas, frame);
  m->set_visibility_layer(r.top, 1, frame);
  m->set_visible(r.top, true, frame);
  m->set_texture_filter(r.top, 0, frame);
  m->set_texture_repeat(r.top, 0, frame);
  m->viewport_attach_canvas(kRootViewport, kLayerCanvas, frame);
  m->viewport_set_canvas_transform(kRootViewport, kLayerCanvas, kLayerXform, frame);
  for (uint64_t rid : {r.modulate, r.layer_box}) {
    m->set_parent(rid, kLayerCanvas, frame);
    m->set_visibility_layer(rid, 1, frame);
    m->set_visible(rid, rid != r.layer_box, frame);
    m->set_texture_filter(rid, rid == r.layer_box ? 1 : 0, frame);
    m->set_texture_repeat(rid, 0, frame);
  }
  m->canvas_set_modulate(kLayerCanvas, kLayerTint, frame);
  // deferred: child draw indices, layer stacking, the canvas groups' raise
  m->set_draw_index(r.box, 0, frame);
  m->set_draw_index(r.behind, 1, frame);
  m->viewport_set_canvas_stacking(kRootViewport, kLayerCanvas, 2, 1, frame);
  m->set_draw_index(r.world, 0, frame);
  m->set_draw_index(r.top, 1, frame);
  m->set_draw_index(r.modulate, 0, frame);
  m->set_draw_index(r.layer_box, 1, frame);
}

AdoptPlan make_plan(const Rids &r) {
  AdoptPlan plan;
  AdoptedLayer layer;
  layer.canvas = kLayerCanvas;
  layer.viewport = kRootViewport;
  layer.xform = kLayerXform;
  layer.layer = 2;
  layer.index = 1;
  plan.layers.push_back(layer);
  auto item = [](uint64_t rid, uint64_t parent, bool group, int32_t index) {
    AdoptedItem a;
    a.rid = rid;
    a.parent = parent;
    a.group_member = group;
    a.child_index = index;
    return a;
  };
  AdoptedItem world = item(r.world, kRootCanvas, true, 0);
  world.xform = kMoved;
  world.modulate = kTint;
  world.canvas_group_mode = 1;  // CG1: the walk's clip_children read, RS defaults
  plan.items.push_back(world);
  AdoptedItem box = item(r.box, r.world, false, 0);
  box.self_modulate = kHalf;
  box.z_index = 1;
  plan.items.push_back(box);
  AdoptedItem behind = item(r.behind, r.world, false, 1);
  behind.behind = true;
  behind.canvas_group_mode = 3;  // CG1: a CanvasGroup's getters
  behind.clear_margin = 10.0f;
  behind.fit_empty = true;
  behind.fit_margin = 10.0f;
  plan.items.push_back(behind);
  AdoptedItem top = item(r.top, kRootCanvas, true, 0);
  top.copy_to_backbuffer = true;  // CG1: a BackBufferCopy in rect mode
  top.copy_rect = {-100.0f, -100.0f, 200.0f, 200.0f};
  plan.items.push_back(top);
  plan.items.push_back(item(r.modulate, kLayerCanvas, true, 0));
  AdoptedItem layer_box = item(r.layer_box, kLayerCanvas, true, 0);
  layer_box.visible = false;
  layer_box.texture_filter = 1;
  plan.items.push_back(layer_box);
  plan.canvas_modulates.push_back({kLayerCanvas, kLayerTint});
  return plan;
}

// The re-raise the walk makes after applying the plan, through the hooks (here: the setter).
void raise(Mirror *m, const Rids &r, uint64_t frame, int32_t base) {
  m->set_draw_index(r.world, base, frame);
  m->set_draw_index(r.top, base + 1, frame);
  m->set_draw_index(r.modulate, base, frame);
  m->set_draw_index(r.layer_box, base + 1, frame);
}

// Field-by-field equality of everything but ids-as-allocated, origin and draw-index values:
// the ids are allocated in the same relative order by both sides here, so they compare directly.
std::string diff_items(const ItemState &a, const ItemState &b) {
  if (a.parent.kind != b.parent.kind || a.parent.id != b.parent.id) return "parent";
  if (a.children != b.children) return "children";
  if (a.xform != b.xform) return "xform";
  if (a.modulate != b.modulate) return "modulate";
  if (a.self_modulate != b.self_modulate) return "self_modulate";
  if (a.visible != b.visible) return "visible";
  if (a.z_index != b.z_index) return "z_index";
  if (a.z_relative != b.z_relative) return "z_relative";
  if (a.behind != b.behind) return "behind";
  if (a.visibility_layer != b.visibility_layer) return "visibility_layer";
  if (a.texture_filter != b.texture_filter) return "texture_filter";
  if (a.texture_repeat != b.texture_repeat) return "texture_repeat";
  if (a.canvas_group.mode != b.canvas_group.mode ||
      a.canvas_group.clear_margin != b.canvas_group.clear_margin ||
      a.canvas_group.fit_empty != b.canvas_group.fit_empty ||
      a.canvas_group.fit_margin != b.canvas_group.fit_margin ||
      a.canvas_group.blur_mipmaps != b.canvas_group.blur_mipmaps)
    return "canvas_group";
  if (a.copy_to_backbuffer != b.copy_to_backbuffer ||
      a.copy_to_backbuffer_rect != b.copy_to_backbuffer_rect)
    return "copy_to_backbuffer";
  return "";
}

std::string diff_canvases(const CanvasState &a, const CanvasState &b) {
  if (a.attached != b.attached) return "attached";
  if (a.layer != b.layer || a.sublayer != b.sublayer) return "stacking";
  if (a.xform != b.xform) return "xform";
  if (a.modulate != b.modulate) return "modulate";
  if (a.items != b.items) return "items";
  return "";
}

// Draw order per container: the children sorted by draw index (stable over list position).
std::vector<uint32_t> order(const Snapshot &s, const std::vector<uint32_t> &ids) {
  std::vector<std::pair<int32_t, uint32_t>> keyed;
  for (uint32_t id : ids)
    for (const ItemState &it : s.items)
      if (it.id == id) keyed.push_back({it.draw_index, id});
  std::stable_sort(keyed.begin(), keyed.end(),
                   [](const auto &x, const auto &y) { return x.first < y.first; });
  std::vector<uint32_t> out;
  for (const auto &k : keyed) out.push_back(k.second);
  return out;
}

void test_born_equals_adopted() {
  const Rids r;
  Mirror born;
  start(&born, grc::rs2::UnknownItemPolicy::Strict);
  drive_born(&born, r, 1);
  Mirror late;
  start(&late, grc::rs2::UnknownItemPolicy::Strict);
  AdoptStats stats;
  grc::rs::apply_adopt_plan(late, make_plan(r), AdoptSabotage::None, 12, &stats);
  raise(&late, r, 12, 7);
  const Snapshot a = born.snapshot(1, 1).state;
  const Snapshot b = late.snapshot(1, 12).state;
  check(a.failures.empty() && b.failures.empty(), "neither side fails");
  check(a.items.size() == b.items.size() && a.canvases.size() == b.canvases.size(),
        "same item and canvas counts");
  for (size_t i = 0; i < a.items.size() && i < b.items.size(); ++i) {
    const std::string d = diff_items(a.items[i], b.items[i]);
    check(d.empty(), "item " + std::to_string(a.items[i].id) + " agrees (" + d + ")");
    check(b.items[i].origin == Origin::Adopted, "adopted items carry origin adopted");
    check(a.items[i].origin == Origin::Created, "born items carry origin created");
  }
  for (size_t i = 0; i < a.canvases.size() && i < b.canvases.size(); ++i) {
    const std::string d = diff_canvases(a.canvases[i], b.canvases[i]);
    check(d.empty(), "canvas " + std::to_string(a.canvases[i].id) + " agrees (" + d + ")");
    check(order(a, a.canvases[i].items) == order(b, b.canvases[i].items),
          "canvas " + std::to_string(a.canvases[i].id) + " draws in the same order");
  }
  check(b.canvases.size() == 2 && b.canvases[1].origin == Origin::Adopted,
        "the layer canvas is adopted");
  check(stats.items == 6 && stats.layers == 1 && stats.canvases == 1 && stats.hidden == 1 &&
            stats.top_level == 4 && stats.canvas_modulates == 1 && stats.canvas_groups == 2 &&
            stats.backbuffer_copies == 1,
        "the stats count the plan");
}

void test_sabotages() {
  const Rids r;
  {
    Mirror m;
    start(&m, grc::rs2::UnknownItemPolicy::Strict);
    AdoptStats stats;
    grc::rs::apply_adopt_plan(m, make_plan(r), AdoptSabotage::SkipState, 12, &stats);
    const Snapshot s = m.snapshot(1, 12).state;
    check(s.items[0].xform == kIdentity && s.items[0].modulate == grc::rs2::kWhite &&
              s.items[1].self_modulate == grc::rs2::kWhite,
          "adopt-skip-state leaves transforms and modulate at the defaults");
    check(s.items[1].z_index == 1 && s.items[1].parent.id == s.items[0].id,
          "adopt-skip-state keeps the structure");
  }
  {
    Mirror m;
    start(&m, grc::rs2::UnknownItemPolicy::Skip);
    AdoptStats stats;
    grc::rs::apply_adopt_plan(m, make_plan(r), AdoptSabotage::SkipLayers, 12, &stats);
    const Snapshot s = m.snapshot(1, 12).state;
    check(stats.layers == 0 && stats.canvases == 0, "adopt-skip-layers adopts no layer");
    check(s.canvases.size() == 1, "adopt-skip-layers leaves only the root canvas");
    check(s.items.size() == 4, "the layer's items are withheld under skip");
    check(m.stats().unknown_rids_named == 1 && s.failures.empty(),
          "the layer canvas is one unknown RID under skip");
  }
  {
    Mirror m;
    start(&m, grc::rs2::UnknownItemPolicy::Strict);
    AdoptStats stats;
    grc::rs::apply_adopt_plan(m, make_plan(r), AdoptSabotage::SkipLayers, 12, &stats);
    const Snapshot s = m.snapshot(1, 12).state;
    check(s.failures.size() == 1 &&
              s.failures[0].reason == grc::rs2::FailureReason::PreExistingObject,
          "under strict the unknown layer canvas is pre-existing-object");
  }
  {
    // adopt-no-redraw acts in the walk (no queue_redraw); the plan application is the honest one.
    Mirror m;
    start(&m, grc::rs2::UnknownItemPolicy::Strict);
    AdoptStats stats;
    grc::rs::apply_adopt_plan(m, make_plan(r), AdoptSabotage::NoRedraw, 12, &stats);
    check(stats.items == 6 && stats.redraws == 0, "adopt-no-redraw applies the plan");
  }
}

void test_residue_and_strict() {
  // An RS-only item the walk never meets: under skip the first later call names one unknown RID
  // and nothing fails; under strict it is the sticky pre-existing-object failure (Q2 adopt-account).
  const Rids r;
  for (bool skip : {true, false}) {
    Mirror m;
    start(&m, skip ? grc::rs2::UnknownItemPolicy::Skip : grc::rs2::UnknownItemPolicy::Strict);
    AdoptStats stats;
    grc::rs::apply_adopt_plan(m, make_plan(r), AdoptSabotage::None, 12, &stats);
    m.set_transform(0x99, kMoved, 16);
    const Snapshot s = m.snapshot(2, 16).state;
    if (skip) {
      check(s.failures.empty() && m.stats().unknown_rids_named == 1,
            "skip: the residue is one unknown RID");
    } else {
      check(s.failures.size() == 1 &&
                s.failures[0].reason == grc::rs2::FailureReason::PreExistingObject,
            "strict: the residue fails pre-existing-object");
    }
  }
}

void test_caps() {
  Mirror m;
  start(&m, grc::rs2::UnknownItemPolicy::Strict);
  m.set_caps(3, 2);
  for (uint64_t rid = 0x40; rid < 0x43; ++rid) m.adopt_item(rid, 1);
  check(m.snapshot(1, 1).state.failures.empty(), "three items fit a cap of 3");
  m.canvas_item_create(0x43, 1);
  const Snapshot over = m.snapshot(2, 1).state;
  check(over.failures.size() == 1 &&
            over.failures[0].reason == grc::rs2::FailureReason::MirrorCapacity,
        "the fourth item is mirror-capacity");
  Mirror c;
  start(&c, grc::rs2::UnknownItemPolicy::Strict);
  c.set_caps(8, 2);
  c.adopt_item(0x50, 1);
  for (int i = 0; i < 3; ++i) c.add_rect(0x50, {0, 0, 1, 1}, grc::rs2::kWhite, false, 1);
  const Snapshot cmds = c.snapshot(1, 1).state;
  check(cmds.failures.size() == 1 && cmds.items[0].commands.size() == 2,
        "the command cap is configurable");
  c.reset();
  c.set_root(kRootViewport, kRootCanvas, kIdentity);
  for (uint64_t rid = 0x60; rid < 0x60 + 9; ++rid) c.canvas_item_create(rid, 1);
  check(c.snapshot(1, 1).state.failures.empty(), "reset() restores the default caps");
}

void test_seam_without_engine() {
  grc::rs::AdoptConfig config;
  config.arm_frame = 3;
  const AdoptStats stats = grc::rs::adopt_at_arm(config);
  check(stats.ran && stats.items == 0 && !stats.error.empty(),
        "without an engine the walk adopts nothing and says why");
  std::string missing;
  check(!grc::rs::adopt_binds_ready(&missing) && !missing.empty(),
        "without an engine the binds are unavailable");
}

}  // namespace

// ------------------------------------------------------------------ G8r: resources by RID

// B3: what the stubbed canvas-texture and multimesh hooks were handed (the fake-engine tests
// below reach them; every stub still refuses, as the engine side never runs here).
namespace {
struct CanvasTextureHookCall {
  uint64_t rid = 0, diffuse = 0, normal = 0, specular = 0;
  int32_t filter = 0, repeat = 0;
};
std::vector<CanvasTextureHookCall> g_ctex_hook_calls;
std::vector<uint64_t> g_multimesh_hook_calls;
bool g_test_standby = false;
bool g_reload_scope_allowed = false;
std::function<void()> g_warm_prepare_probe;
std::function<void()> g_warm_free_probe;
bool g_reload_adopt = false;
bool g_hold_adopt = false;
void *g_reload_adopt_image = nullptr;
int g_guard_entries = 0;
// LAR2: what the multimesh hook was handed (the buffer by size).
struct MultimeshHookCall {
  uint64_t rid = 0, mesh = 0;
  int32_t instances = 0, format = 0, visible = 0;
  bool colors = false, custom = false, indirect = false;
  size_t floats = 0;
  float first = 0.0f;
};
std::vector<MultimeshHookCall> g_multimesh_hook_args;
// LAR5: what the emitter hook was handed.
std::vector<std::pair<uint64_t, grc::rs::Mirror::ParticlesAdopt>> g_particles_hook_args;
}  // namespace

// rs_adopt.cpp calls the hooks' copy path through these; the engine side never runs here.
namespace grc {
namespace rs {
void adopt_test_before_warm_free_classify() {
  if (g_warm_free_probe) g_warm_free_probe();
}
}
OffmainGuard::OffmainGuard(bool, const char *) { ++g_guard_entries; }
OffmainGuard::~OffmainGuard() {}
bool hooks_offmain_standby() { return g_test_standby; }
bool hooks_test_inflight_delay(std::unique_lock<std::mutex> *) { return true; }
bool hooks_reload_scope_begin() { return g_reload_scope_allowed; }
void hooks_reload_scope_end(ReloadScopeCounts *out) { *out = {1, 1, 0}; }
bool hooks_adopt_texture(uint64_t, void *image, rs2::AdoptedContent content, const char *source, bool *) {
  if (g_reload_adopt && content == rs2::AdoptedContent::Current &&
      (std::string(source) == "reload" || (g_hold_adopt && std::string(source) == "hold"))) {
    g_reload_adopt_image = image;
    return true;
  }
  return false;
}
bool hooks_warm_texture(void *image, rs::WarmBody *out) {
  if (image == nullptr) return false;
  if (g_warm_prepare_probe) g_warm_prepare_probe();
  auto bytes = std::make_shared<rs::PayloadBytes>();
  bytes->resize(sizeof(image));
  std::memcpy(bytes->data(), &image, sizeof(image));
  out->copy.status = "ok";
  out->bytes = std::move(bytes);
  return true;
}
bool hooks_adopt_texture_warm(uint64_t rid, rs::WarmBody body, rs2::AdoptedContent content,
                              const char *source, bool *decoded) {
  void *image = nullptr;
  if (body.bytes != nullptr && body.bytes->size() == sizeof(image)) {
    std::memcpy(&image, body.bytes->data(), sizeof(image));
  }
  return hooks_adopt_texture(rid, image, content, source, decoded);
}
bool hooks_warm_promote(const std::shared_ptr<rs::WarmTaskBase> &) { return false; }
bool hooks_adopt_mesh(uint64_t, const std::vector<rs::AdoptSurface> &, const float[6]) {
  return false;
}
// G8m: the material path's hooks (never reached here: the engine walk does not run).
void hooks_internal_begin(std::string *, uint64_t *) {}
void hooks_internal_end() {}
bool hooks_adopt_shader(uint64_t, const std::string &) { return false; }
bool hooks_adopt_shader_refused(uint64_t, rs2::ShaderReason) { return false; }
void hooks_adopt_default_texture(uint64_t, const std::string &, uint64_t, int32_t) {}
bool hooks_adopt_material(uint64_t, uint64_t, const std::vector<rs::AdoptParam> &) {
  return false;
}
void hooks_adopt_item_material(uint64_t, uint64_t) {}
void hooks_adopt_material_shader(uint64_t, uint64_t) {}
void hooks_adopt_instance_param(uint64_t, const std::string &, const void *) {}
// PM7: the emitter path's hooks (likewise never reached).
void hooks_internal_material(std::vector<std::string> *, uint64_t *) {}
bool hooks_adopt_particles(uint64_t rid, const rs::Mirror::ParticlesAdopt &a) {
  g_particles_hook_args.push_back({rid, a});
  return false;
}
void hooks_adopt_particles_subemitter(uint64_t, uint64_t) {}
// PM9: the multimesh and canvas texture paths' hooks (likewise never reached).
bool hooks_adopt_multimesh(uint64_t rid, rs::Mirror::MultimeshAdopt a) {
  g_multimesh_hook_calls.push_back(rid);
  g_multimesh_hook_args.push_back({rid, a.mesh, a.instances, a.format, a.visible, a.colors,
                                   a.custom, a.indirect, a.buffer.size(),
                                   a.buffer.empty() ? 0.0f : a.buffer[0]});
  return false;
}
bool hooks_adopt_canvas_texture(uint64_t rid, uint64_t diffuse, uint64_t normal, uint64_t specular,
                                int32_t filter, int32_t repeat) {
  g_ctex_hook_calls.push_back({rid, diffuse, normal, specular, filter, repeat});
  return false;
}
// LATE-RES: the node_added adoption stamps its taps with the hook frame; the engine side never
// runs here.
uint64_t hooks_current_frame() { return 1; }
}  // namespace grc
namespace {

grc::rs::PayloadCopy rgba_copy(const std::string &hash) {
  grc::rs::PayloadCopy c;
  c.status = "ok";
  c.format = 5;  // RGBA8
  c.width = 4;
  c.height = 4;
  c.mipmaps_known = true;
  c.mipmaps = false;
  c.data_bytes = 64;
  c.payload_bytes = 100;
  c.hash = hash;
  return c;
}

grc::rs::PayloadPtr some_bytes() { return std::make_shared<grc::rs::PayloadBytes>(100, 7); }

grc::rs::MeshSurfaceInput mesh_input(const std::string &hash) {
  grc::rs::MeshSurfaceInput in;
  in.copy.status = "ok";
  in.copy.primitive = 3;
  in.copy.format = 0x1 | 0x4;
  in.copy.vertex_count = 4;
  in.copy.index_count = 6;
  in.copy.hash = hash;
  in.bytes = some_bytes();
  return in;
}

const std::string kHashA(64, 'a');
const std::string kHashB(64, 'b');
const std::string kHashM(64, 'c');

// Born: a texture and a mesh created under the hooks, drawn by one item. Late: the same item
// adopted, the texture and mesh adopted at their first reference, the same draws. The snapshots
// agree on everything but origin and adopted_content (D15.1 for resources).
void test_resources_born_equals_adopted() {
  constexpr uint64_t kItem = 0x40, kTex = 0x50, kMesh = 0x60;
  const grc::rs2::Rect4 rect = {0, 0, 32, 32};
  Mirror born;
  start(&born, grc::rs2::UnknownItemPolicy::Strict);
  born.canvas_item_create(kItem, 1);
  born.set_parent(kItem, kRootCanvas, 1);
  born.texture_2d_create(kTex, rgba_copy(kHashA), some_bytes(), 1);
  born.mesh_create_from_surfaces(kMesh, {mesh_input(kHashM)}, 1);
  born.add_texture_rect(kItem, rect, kTex, false, grc::rs2::kWhite, false, 2);
  born.add_mesh(kItem, kMesh, kIdentity, grc::rs2::kWhite, kTex, 2);

  Mirror late;
  start(&late, grc::rs2::UnknownItemPolicy::Strict);
  late.adopt_item(kItem, 1);
  late.set_parent(kItem, kRootCanvas, 1);
  check(!late.knows_texture(kTex) && !late.knows_mesh(kMesh), "r: unknown before adoption");
  late.texture_adopt(kTex, rgba_copy(kHashA), some_bytes(), grc::rs2::AdoptedContent::Creation, 2);
  late.mesh_adopt(kMesh, {mesh_input(kHashM)}, {0, 0, 0, 0, 0, 0}, 2);
  check(late.knows_texture(kTex) && late.knows_mesh(kMesh), "r: known after adoption");
  // A second adoption of a known RID changes nothing (no new id).
  late.texture_adopt(kTex, rgba_copy(kHashB), some_bytes(), grc::rs2::AdoptedContent::Current, 2);
  late.add_texture_rect(kItem, rect, kTex, false, grc::rs2::kWhite, false, 2);
  late.add_mesh(kItem, kMesh, kIdentity, grc::rs2::kWhite, kTex, 2);

  const Snapshot b = born.snapshot(1, 2).state;
  const Snapshot l = late.snapshot(1, 2).state;
  check(b.textures.size() == 1 && l.textures.size() == 1, "r: one texture each");
  check(b.meshes.size() == 1 && l.meshes.size() == 1, "r: one mesh each");
  if (b.textures.size() == 1 && l.textures.size() == 1) {
    const auto &bt = b.textures[0];
    const auto &lt = l.textures[0];
    check(bt.origin == Origin::Created && bt.adopted_content == grc::rs2::AdoptedContent::None,
          "r: born texture created");
    check(lt.origin == Origin::Adopted && lt.adopted_content == grc::rs2::AdoptedContent::Creation,
          "r: late texture adopted, creation");
    check(bt.hash == lt.hash && lt.hash == kHashA && bt.format == lt.format &&
              bt.width == lt.width && bt.status == lt.status && bt.version == lt.version,
          "r: texture entries equal but for origin");
  }
  if (b.meshes.size() == 1 && l.meshes.size() == 1) {
    check(l.meshes[0].origin == Origin::Adopted &&
              l.meshes[0].adopted_content == grc::rs2::AdoptedContent::Creation,
          "r: late mesh adopted, creation");
    check(b.meshes[0].surfaces.size() == 1 && l.meshes[0].surfaces.size() == 1 &&
              b.meshes[0].surfaces[0].hash == l.meshes[0].surfaces[0].hash,
          "r: mesh surfaces equal");
  }
  const auto *bi = b.items.empty() ? nullptr : &b.items[0];
  const auto *li = l.items.empty() ? nullptr : &l.items[0];
  check(bi != nullptr && li != nullptr && bi->commands.size() == 2 && li->commands.size() == 2,
        "r: two commands each");
  if (bi != nullptr && li != nullptr && bi->commands.size() == 2 && li->commands.size() == 2) {
    check(bi->commands[0].kind == li->commands[0].kind &&
              li->commands[0].kind == grc::rs2::CommandKind::AddTextureRect &&
              li->commands[0].has_tex && li->commands[0].tex == l.textures[0].id,
          "r: the texture rect names the adopted texture");
    check(li->commands[1].kind == grc::rs2::CommandKind::AddMesh &&
              li->commands[1].mesh == l.meshes[0].id,
          "r: add_mesh names the adopted mesh");
  }
  check(l.unsupported.empty(), "r: no unknown-texture / unknown-mesh entry");

  // Without adoption the same draws are G8a's typed refusals.
  Mirror refused;
  start(&refused, grc::rs2::UnknownItemPolicy::Strict);
  refused.adopt_item(kItem, 1);
  refused.set_parent(kItem, kRootCanvas, 1);
  refused.add_texture_rect(kItem, rect, kTex, false, grc::rs2::kWhite, false, 2);
  refused.add_mesh(kItem, kMesh, kIdentity, grc::rs2::kWhite, 0, 2);
  const Snapshot r = refused.snapshot(1, 2).state;
  bool unknown_texture = false, unknown_mesh = false;
  for (const auto &u : r.unsupported) {
    unknown_texture = unknown_texture || u.reason == grc::rs2::UnsupportedReason::UnknownTexture;
    unknown_mesh = unknown_mesh || u.reason == grc::rs2::UnsupportedReason::UnknownMesh;
  }
  check(unknown_texture && unknown_mesh, "r: unadopted draws stay unknown-texture/unknown-mesh");
}

// adopted_content follows the entry: a whole update (or a replace by a created texture, or a mesh
// clear) makes an adopted entry's content the hooks' own: current, at a higher version.
void test_resources_refinement() {
  constexpr uint64_t kTex = 0x50, kOther = 0x51, kNew = 0x52, kMesh = 0x60;
  Mirror m;
  start(&m, grc::rs2::UnknownItemPolicy::Strict);
  m.texture_adopt(kTex, rgba_copy(kHashA), some_bytes(), grc::rs2::AdoptedContent::Creation, 1);
  m.texture_adopt(kOther, rgba_copy(kHashA), some_bytes(), grc::rs2::AdoptedContent::Creation, 1);
  m.mesh_adopt(kMesh, {mesh_input(kHashM)}, {0, 0, 0, 0, 0, 0}, 1);
  m.texture_2d_update(kTex, rgba_copy(kHashB), some_bytes(), 0, 2);
  m.texture_2d_create(kNew, rgba_copy(kHashB), some_bytes(), 2);
  m.texture_replace(kOther, kNew, 2);
  m.mesh_clear(kMesh, 2);
  const Snapshot s = m.snapshot(1, 2).state;
  int current = 0;
  for (const auto &t : s.textures) {
    check(t.origin == Origin::Adopted, "refine: still adopted");
    check(t.version == 2, "refine: version raised");
    current += t.adopted_content == grc::rs2::AdoptedContent::Current ? 1 : 0;
    check(t.hash == kHashB, "refine: the update's / replacement's content");
  }
  check(s.textures.size() == 2 && current == 2, "refine: update and replace give current");
  check(s.meshes.size() == 1 &&
            s.meshes[0].adopted_content == grc::rs2::AdoptedContent::Current,
        "refine: mesh_clear gives current");
  // A layered or mismatched update leaves the trust where it was.
  Mirror n;
  start(&n, grc::rs2::UnknownItemPolicy::Strict);
  n.texture_adopt(kTex, rgba_copy(kHashA), some_bytes(), grc::rs2::AdoptedContent::Creation, 1);
  n.texture_2d_update(kTex, rgba_copy(kHashB), some_bytes(), 1, 2);
  const Snapshot t = n.snapshot(1, 2).state;
  check(t.textures.size() == 1 &&
            t.textures[0].adopted_content == grc::rs2::AdoptedContent::Creation,
        "refine: a layered update keeps creation");
}

// The hook log registers an adopted texture/mesh exactly as a create, on an "adopt" line.
void test_resources_log() {
  grc::rs::ResourceLog log;
  log.start(0, kRootViewport);
  grc::rs::TapContext ctx;
  ctx.frame = 3;
  log.texture_adopt(ctx, 0x50, rgba_copy(kHashA), "current", "textserver");
  log.texture_adopt(ctx, 0x50, rgba_copy(kHashB), "creation", "dummy");  // known: no line
  std::vector<grc::rs::MeshSurfaceCopy> surfaces = {mesh_input(kHashM).copy};
  log.mesh_adopt(ctx, 0x60, surfaces);
  log.texture_2d_update(ctx, 0x50, rgba_copy(kHashB), 0);
  const std::string text = log.take_lines();
  std::vector<std::string> lines;
  size_t at = 0;
  while (at < text.size()) {
    const size_t nl = text.find('\n', at);
    lines.push_back(text.substr(at, nl - at));
    at = nl + 1;
  }
  check(lines.size() == 3, "log: adopt, adopt (mesh), update");
  if (lines.size() == 3) {
    check(lines[0].find("\"op\":\"adopt\"") != std::string::npos &&
              lines[0].find("\"id\":1,") != std::string::npos &&
              lines[0].find("\"version\":1,") != std::string::npos &&
              lines[0].find("\"adopted_content\":\"current\",\"adopt_source\":\"textserver\"") !=
                  std::string::npos,
          "log: texture adopt line " + lines[0]);
    check(lines[1].find("\"op\":\"adopt\"") != std::string::npos &&
              lines[1].find("\"kind\":\"mesh\"") != std::string::npos &&
              lines[1].find("\"adopted_content\":\"creation\"") != std::string::npos,
          "log: mesh adopt line " + lines[1]);
    check(lines[2].find("\"op\":\"texture_2d_update\"") != std::string::npos &&
              lines[2].find("\"version\":2,") != std::string::npos &&
              lines[2].find("adopted_content") == std::string::npos,
          "log: the update after adoption is an ordinary update " + lines[2]);
  }
}

void test_adopt_fault_parse() {
  grc::rs::AdoptFault f = grc::rs::AdoptFault::ClaimCurrent;
  std::string error;
  check(grc::rs::parse_adopt_fault(nullptr, false, &f, &error) && f == grc::rs::AdoptFault::None,
        "fault: unset is none");
  check(grc::rs::parse_adopt_fault("atlas-from-dummy", true, &f, &error) &&
            f == grc::rs::AdoptFault::AtlasFromDummy,
        "fault: atlas-from-dummy");
  check(grc::rs::parse_adopt_fault("claim-current", true, &f, &error) &&
            f == grc::rs::AdoptFault::ClaimCurrent,
        "fault: claim-current");
  check(grc::rs::parse_adopt_fault("no-resources", true, &f, &error) &&
            f == grc::rs::AdoptFault::NoResources,
        "fault: no-resources");
  check(!grc::rs::parse_adopt_fault("no-resources", false, &f, &error), "fault: needs GRC_ADOPT");
  check(!grc::rs::parse_adopt_fault("bogus", true, &f, &error), "fault: unknown value refused");
  check(grc::rs::parse_adopt_fault("hold-off", true, &f, &error) &&
            std::string(grc::rs::adopt_fault_name(f)) == "hold-off",
        "hold fault: accepted and named");
  check(!grc::rs::parse_adopt_fault("hold-off", false, &f, &error),
        "hold fault: needs GRC_ADOPT");
  check(!grc::rs::parse_adopt_fault("bogus", true, &f, &error) &&
            error.find("hold-off") != std::string::npos,
        "hold fault: listed in invalid-value diagnostic");
  check(grc::rs::parse_adopt_fault("registry-queue-drop", true, &f, &error) &&
            f == grc::rs::AdoptFault::RegistryQueueDrop &&
            std::string(grc::rs::adopt_fault_name(f)) == "registry-queue-drop",
        "fault: registry-queue-drop (LAR6)");
  for (const char *name : {"reload-off", "reload-skip-verify", "skip-htr-restore"}) {
    check(grc::rs::parse_adopt_fault(name, true, &f, &error), "reload fault: accepted");
    check(std::string(grc::rs::adopt_fault_name(f)) == name, "reload fault: name round trip");
    check(!grc::rs::parse_adopt_fault(name, false, &f, &error) &&
              error.find("set GRC_ADOPT=arm") != std::string::npos,
          "reload fault: requires adoption");
  }
  // Lazy adoption is off until a stream begins it; every entry point is then a no-op.
  check(!grc::rs::adopt_resources_active(), "lazy: inactive by default");
  grc::rs::materialize(0x50, grc::rs::RefKind::Texture);
  grc::rs::materialize(0x60, grc::rs::RefKind::Mesh);
  check(!grc::rs::adopt_from_update_begin(), "lazy: no update adoption while inactive");
  check(grc::rs::adopt_resource_stats().textures == 0, "lazy: nothing counted");
}

}  // namespace

// ------------------------------------------------------------------ G8m: materials, shaders

namespace {

grc::rs::ShaderCodeInput shader_input(const std::string &code) {
  grc::rs::ShaderCodeInput in;
  in.copy.status = "ok";
  in.copy.mode = "canvas_item";
  const grc::rs::CanvasItemMaterialBuiltin b = grc::rs::recognize_canvas_item_material(code);
  in.copy.builtin = b.recognized;
  in.copy.builtin_blend_mode = b.blend_mode;
  in.copy.builtin_light_mode = b.light_mode;
  in.copy.builtin_particles_animation = b.particles_animation;
  auto bytes = std::make_shared<grc::rs::PayloadBytes>(grc::rs::encode_payload(code));
  in.copy.hash = std::string(64, code.size() % 2 == 0 ? 'a' : 'b');
  in.copy.payload_bytes = static_cast<int64_t>(bytes->size());
  in.copy.code_bytes = static_cast<int64_t>(code.size());
  in.bytes = bytes;
  return in;
}

grc::rs::DecodedParam float_param(double v) {
  grc::rs::DecodedParam p;
  p.type = "float";
  p.n = 1;
  p.f = {v};
  return p;
}

// Born: the hooks see the shader and material created and set; late: the same objects adopted
// (shader_adopt, material_adopt, then the hooks' own setters), after an item already named the
// material (unknown-material until then, listed as pending).
void test_materials_born_equals_adopted() {
  constexpr uint64_t kItem = 0x40, kShader = 0x70, kMaterial = 0x80, kShader2 = 0x71;
  const std::string code = "shader_type canvas_item;\nuniform float gain;\nvoid fragment() {}\n";
  Mirror born;
  start(&born, grc::rs2::UnknownItemPolicy::Strict);
  born.canvas_item_create(kItem, 1);
  born.set_parent(kItem, kRootCanvas, 1);
  born.shader_create_from_code(kShader, shader_input(code), 1);
  born.material_create_from_shader(kMaterial, kShader, 1);
  born.material_set_param(kMaterial, "gain", float_param(0.5), 1);
  born.set_material(kItem, kMaterial, 1);

  Mirror late;
  start(&late, grc::rs2::UnknownItemPolicy::Strict);
  late.adopt_item(kItem, 1);
  late.set_parent(kItem, kRootCanvas, 1);
  late.set_material_refs_queue(true);  // LAR3: adoption's arm turns the pending queue on
  late.set_material(kItem, kMaterial, 1);
  check(late.has_pending_material_refs(), "m: an unknown material reference is queued");
  auto pending = late.take_pending_material_refs();
  check(pending.items.size() == 1 && pending.items[0].first == kItem &&
            pending.items[0].second == kMaterial && pending.materials.empty(),
        "m: the item's unknown material is pending");
  Snapshot u = late.snapshot(1, 1).state;
  check(u.items.size() == 1 && !u.items[0].has_material && u.unsupported.size() == 1 &&
            u.unsupported[0].reason == grc::rs2::UnsupportedReason::UnknownMaterial,
        "m: unresolved, the item is unknown-material");
  late.shader_adopt(kShader, shader_input(code), 2);
  late.material_adopt(kMaterial, 2);
  late.material_set_shader(kMaterial, kShader, 2);
  late.material_set_param(kMaterial, "gain", float_param(0.5), 2);
  late.set_material(kItem, kMaterial, 2);
  check(late.knows_shader(kShader) && late.knows_material(kMaterial), "m: known after adoption");
  check(late.take_pending_material_refs().items.empty(), "m: nothing pending after resolution");
  std::string got;
  check(late.shader_code_of(kShader, &got) && got == code, "m: the adopted shader's code");
  const Snapshot b = born.snapshot(2, 2).state;
  const Snapshot l = late.snapshot(2, 2).state;
  check(b.shaders.size() == 1 && l.shaders.size() == 1 && b.materials.size() == 1 &&
            l.materials.size() == 1,
        "m: one shader and one material each");
  if (b.shaders.size() == 1 && l.shaders.size() == 1) {
    check(b.shaders[0].origin == Origin::Created && l.shaders[0].origin == Origin::Adopted,
          "m: shader origins");
    check(b.shaders[0].hash == l.shaders[0].hash && l.shaders[0].has_hash &&
              b.shaders[0].status == l.shaders[0].status,
          "m: shader entries equal but for origin");
  }
  if (b.materials.size() == 1 && l.materials.size() == 1) {
    check(l.materials[0].origin == Origin::Adopted, "m: material adopted");
    check(l.materials[0].has_shader && l.materials[0].shader == l.shaders[0].id &&
              l.materials[0].params.size() == 1 && l.materials[0].params[0].name == "gain" &&
              b.materials[0].params.size() == 1,
          "m: the adopted material names its shader and parameter");
  }
  check(l.items.size() == 1 && l.items[0].has_material && l.unsupported.empty(),
        "m: the item names the adopted material, no unknown-material");

  // A post-arm material on an unknown (pre-arm) shader is pending through its items.
  late.material_create_from_shader(0x81, kShader2, 3);
  late.set_material(kItem, 0x81, 3);
  pending = late.take_pending_material_refs();
  check(pending.materials.size() == 1 && pending.materials[0].shader == kShader2 &&
            pending.materials[0].items.size() == 1 && pending.materials[0].items[0] == kItem,
        "m: a material's unknown shader is pending with its item");
  // D12: a template shader adopted under a synthetic key is re-keyed to the RID a call names.
  constexpr uint64_t kSynthetic = (1ull << 63) | 0x1;
  late.shader_adopt(kSynthetic, shader_input(code), 3);
  late.shader_rebind(kSynthetic, kShader2);
  check(late.knows_shader(kShader2) && !late.knows_shader(kSynthetic), "m: rebind re-keys");
  late.material_set_shader(0x81, kShader2, 3);
  check(late.take_pending_material_refs().materials.empty(), "m: resolved after the rebind");
  // Q5: an unrecoverable shader keeps the no-code shape, unsupported, shader-adopt-include.
  late.shader_adopt_refused(0x72, grc::rs2::ShaderReason::ShaderAdoptInclude, 3);
  const Snapshot r = late.snapshot(3, 3).state;
  bool refused = false;
  for (const auto &sh : r.shaders) {
    refused = refused || (sh.origin == Origin::Adopted && sh.has_reason &&
                          sh.reason == grc::rs2::ShaderReason::ShaderAdoptInclude &&
                          sh.status == grc::rs2::ShaderStatus::Unsupported && !sh.has_hash &&
                          !sh.has_mode);
  }
  check(refused, "m: shader-adopt-include entry");
  check(std::string(grc::rs2::to_wire(grc::rs2::ShaderReason::ShaderAdoptInclude)) ==
            "shader-adopt-include",
        "m: wire spelling");
}

void test_material_scans() {
  const auto u = grc::rs::scan_uniforms(
      "shader_type canvas_item;\n// uniform float commented;\n/* uniform int c2; */\n"
      "@@>res://inc/a.gdshaderinc\nuniform vec4 tint = vec4(1.0);\n@@<res://inc/a.gdshaderinc\n"
      "uniform sampler2D pal : filter_nearest;\ninstance uniform vec4 inst;\n"
      "global uniform vec4 g;\nuniform lowp float arr[3];\nvoid fragment() {}\n");
  check(u.size() == 3 && u[0].name == "tint" && !u[0].sampler && u[1].name == "pal" &&
            u[1].sampler && u[2].name == "arr",
        "scan: uniform names, samplers, instance/global/comments skipped");
  // FOG-U: a declared type and default are read (a vec4(1.0) constructor, splatted).
  check(u[0].kind == grc::rs::UniformDecl::Kind::Vector && u[0].components == 4 &&
            u[0].has_default && u[0].default_[0] == 1.0f && u[0].default_[3] == 1.0f,
        "scan: a vecN default is read and splatted");
  const auto proc = grc::rs::scan_uniforms(
      "shader_type particles;\nuniform float inherit_emitter_velocity_ratio = 0.0;\n"
      "uniform vec3 emission_shape_scale = vec3(1.0);\n"
      "uniform vec3 turbulence_noise_speed = vec3(1.0, 1.0, 1.0);\n"
      "uniform int collision_mode = 2;\nvoid process() {}\n");
  check(proc.size() == 4 && proc[0].name == "inherit_emitter_velocity_ratio" &&
            proc[0].kind == grc::rs::UniformDecl::Kind::Float && proc[0].components == 1 &&
            proc[0].has_default && proc[0].default_[0] == 0.0f &&
            proc[1].kind == grc::rs::UniformDecl::Kind::Vector && proc[1].components == 3 &&
            proc[1].has_default && proc[1].default_[0] == 1.0f && proc[1].default_[2] == 1.0f &&
            proc[2].has_default && proc[2].default_[0] == 1.0f && proc[2].default_[2] == 1.0f &&
            proc[3].kind == grc::rs::UniformDecl::Kind::Int && proc[3].default_[0] == 2.0f,
        "scan: a process shader's float/vec3/int defaults");
  check(grc::rs::has_include_directive("shader_type canvas_item;\n  #include \"x.gdshaderinc\"\n"),
        "include: a left-over directive");
  check(!grc::rs::has_include_directive("shader_type canvas_item;\n@@>res://x\n"),
        "include: markers only");
  const std::string version = grc::rs::canvas_item_material_version_text(
      "Godot Engine v4.5.1.stable.official", "official");
  check(version == "Godot Engine 4.5.1.stable", "cim: version text from the full name");
  check(grc::rs::canvas_item_material_version_text("Godot Engine v4.5.1.stable.mono.official",
                                                   "official") == "Godot Engine 4.5.1.stable.mono",
        "cim: version text keeps the module config");
  for (int blend = 0; blend < 6; ++blend) {
    for (int light = 0; light < 3; ++light) {
      for (bool particles : {false, true}) {
        const auto b = grc::rs::recognize_canvas_item_material(
            grc::rs::canvas_item_material_code(version, blend, light, particles));
        static const char *kBlend[] = {"mix", "add", "sub", "mul", "premul_alpha", "disabled"};
        static const char *kLight[] = {"normal", "unshaded", "light_only"};
        check(b.recognized && b.blend_mode == kBlend[blend] && b.light_mode == kLight[light] &&
                  b.particles_animation == particles,
              "cim: the rebuilt template is recognized as its own mode");
      }
    }
  }
  check(grc::rs::canvas_item_material_code(version, 6, 0, false).empty(), "cim: out of range");
  grc::rs::AdoptFault f = grc::rs::AdoptFault::None;
  std::string error;
  check(grc::rs::parse_adopt_fault("no-include-path", true, &f, &error) &&
            f == grc::rs::AdoptFault::NoIncludePath,
        "fault: no-include-path");
  check(grc::rs::parse_adopt_fault("no-particles", true, &f, &error) &&
            f == grc::rs::AdoptFault::NoParticles &&
            std::string(grc::rs::adopt_fault_name(f)) == "no-particles",
        "fault: no-particles");
  // LAR4: ppm-no-shader went with PM7's duplicate (its only site); registry-drop-binding is new.
  check(!grc::rs::parse_adopt_fault("ppm-no-shader", true, &f, &error),
        "fault: ppm-no-shader is gone");
  check(grc::rs::parse_adopt_fault("registry-skip-particles", true, &f, &error) &&
            f == grc::rs::AdoptFault::RegistrySkipParticles &&
            std::string(grc::rs::adopt_fault_name(f)) == "registry-skip-particles",
        "fault: registry-skip-particles (LAR5)");
  check(grc::rs::parse_adopt_fault("registry-drop-binding", true, &f, &error) &&
            f == grc::rs::AdoptFault::RegistryDropBinding &&
            std::string(grc::rs::adopt_fault_name(f)) == "registry-drop-binding",
        "fault: registry-drop-binding");
  // LAR0: the registry's knobs parse like the others and also need GRC_ADOPT=arm.
  check(grc::rs::parse_adopt_fault("registry-off", true, &f, &error) &&
            f == grc::rs::AdoptFault::RegistryOff &&
            std::string(grc::rs::adopt_fault_name(f)) == "registry-off",
        "fault: registry-off");
  check(grc::rs::parse_adopt_fault("registry-keep-freed", true, &f, &error) &&
            f == grc::rs::AdoptFault::RegistryKeepFreed &&
            std::string(grc::rs::adopt_fault_name(f)) == "registry-keep-freed",
        "fault: registry-keep-freed");
  check(!grc::rs::parse_adopt_fault("registry-keep-freed", false, &f, &error),
        "fault: registry-keep-freed needs GRC_ADOPT=arm");
  // LAR2: registry-mm-stride (the multimesh adoption guesses the format from the stride).
  check(grc::rs::parse_adopt_fault("registry-mm-stride", true, &f, &error) &&
            f == grc::rs::AdoptFault::RegistryMmStride &&
            std::string(grc::rs::adopt_fault_name(f)) == "registry-mm-stride",
        "fault: registry-mm-stride");
  check(!grc::rs::parse_adopt_fault("registry-mm-stride", false, &f, &error),
        "fault: registry-mm-stride needs GRC_ADOPT=arm");
  // Inactive: the frame-boundary resolution and the arm pass are no-ops.
  grc::rs::adopt_materials_resolve();
  grc::rs::adopt_materials_at_arm();
  check(grc::rs::adopt_material_stats().materials == 0, "m: nothing adopted while inactive");
}

}  // namespace

// ------------------------------------------------------------------ B3: adoption failure paths

namespace {

using Key = grc::rs2::BuiltinParticleProcessMaterial;

// The synthetic process shader's key bits must be injective: two keys share a reserved shader RID
// only when they are equal. The h*31 hash it replaced mapped {textures 1} and {the five ramp/curve
// flags} to one value, so two different emitters drew with one key.
void test_ppm_key_bits() {
  using grc::rs::ppm_key_bits;
  Key textures;
  textures.textures = 1;
  Key curves;
  curves.color_ramp = curves.color_initial_ramp = curves.alpha_curve = curves.emission_curve =
      curves.velocity_limit_curve = true;
  // The replaced hash (rs_adopt.cpp before B3), kept here to show the pair did collide.
  auto old_hash = [](const Key &k) {
    uint64_t h = 1;
    auto mix = [&h](uint64_t v) { h = h * 31 + v; };
    mix(k.emission_shape);
    mix(k.particle_flags);
    mix(k.textures);
    mix((k.color_ramp ? 1u : 0u) | (k.color_initial_ramp ? 2u : 0u) | (k.alpha_curve ? 4u : 0u) |
        (k.emission_curve ? 8u : 0u) | (k.velocity_limit_curve ? 16u : 0u) |
        (k.orbit_velocity_curve_xyz ? 32u : 0u) | (k.emission_color_texture ? 64u : 0u));
    mix(k.sub_emitter | (k.attractor ? 256u : 0u));
    mix(k.collision | (k.collision_scale ? 8u : 0u) | (k.turbulence ? 16u : 0u));
    return h & ((1ull << 62) - 1);
  };
  check(old_hash(textures) == old_hash(curves), "ppm bits: the pair collided under the old hash");
  check(ppm_key_bits(textures) != ppm_key_bits(curves), "ppm bits: the colliding pair differs");

  // Every single-field variation of the default key: all distinct, none the default's bits.
  std::vector<Key> keys(1);
  for (uint8_t s = 1; s < grc::rs2::kPpmEmissionShapes; ++s) {
    keys.emplace_back();
    keys.back().emission_shape = s;
  }
  for (int i = 0; i < grc::rs2::kPpmFlagCount; ++i) {
    keys.emplace_back();
    keys.back().particle_flags = 1u << i;
  }
  for (int i = 0; i < grc::rs2::kPpmParamCount; ++i) {
    keys.emplace_back();
    keys.back().textures = 1u << i;
  }
  for (bool Key::*flag :
       {&Key::color_ramp, &Key::color_initial_ramp, &Key::alpha_curve, &Key::emission_curve,
        &Key::velocity_limit_curve, &Key::orbit_velocity_curve_xyz, &Key::emission_color_texture,
        &Key::attractor, &Key::collision_scale, &Key::turbulence}) {
    keys.emplace_back();
    keys.back().*flag = true;
  }
  for (uint8_t s = 1; s < grc::rs2::kPpmSubEmitterModes; ++s) {
    keys.emplace_back();
    keys.back().sub_emitter = s;
  }
  for (uint8_t c = 1; c < grc::rs2::kPpmCollisionModes; ++c) {
    keys.emplace_back();
    keys.back().collision = c;
  }
  std::set<uint64_t> single;
  bool in_40_bits = true;
  for (const Key &k : keys) {
    single.insert(ppm_key_bits(k));
    in_40_bits = in_40_bits && (ppm_key_bits(k) >> 40) == 0;
  }
  check(single.size() == keys.size(), "ppm bits: every single-field variation is distinct");
  check(ppm_key_bits(Key()) == 0, "ppm bits: the default key is 0");

  // Random in-range keys: equal bits only for equal keys, and never into the reserved top bits.
  std::mt19937_64 rng(0xB3);
  std::map<uint64_t, Key> seen;
  bool injective = true;
  for (int n = 0; n < 200000; ++n) {
    const uint64_t r = rng();
    Key k;
    k.emission_shape = static_cast<uint8_t>(r % grc::rs2::kPpmEmissionShapes);
    k.particle_flags = static_cast<uint32_t>((r >> 3) & 0xf);
    k.textures = static_cast<uint32_t>((r >> 7) & 0x3ffff);
    k.color_ramp = (r >> 25) & 1;
    k.color_initial_ramp = (r >> 26) & 1;
    k.alpha_curve = (r >> 27) & 1;
    k.emission_curve = (r >> 28) & 1;
    k.velocity_limit_curve = (r >> 29) & 1;
    k.orbit_velocity_curve_xyz = (r >> 30) & 1;
    k.emission_color_texture = (r >> 31) & 1;
    k.sub_emitter = static_cast<uint8_t>((r >> 32) % grc::rs2::kPpmSubEmitterModes);
    k.attractor = (r >> 40) & 1;
    k.collision = static_cast<uint8_t>((r >> 41) % grc::rs2::kPpmCollisionModes);
    k.collision_scale = (r >> 50) & 1;
    k.turbulence = (r >> 51) & 1;
    const uint64_t bits = ppm_key_bits(k);
    in_40_bits = in_40_bits && (bits >> 40) == 0;
    const auto at = seen.emplace(bits, k);
    injective = injective && (at.second || at.first->second == k);
  }
  check(injective, "ppm bits: 200000 random keys, equal bits only for equal keys");
  check(in_40_bits, "ppm bits: every key fits 40 bits (below the reserved top bits)");
}

// --- the engine paths, over test/fake_godot_iface.h --------------------------------------------

using FakeArgs = const GDExtensionConstTypePtr *;

// A stream as entry.cpp arms one: a fresh mirror session with the root bound, then lazy adoption
// on this (the main) thread.
void stream_begin() {
  grc::rs::mirror_enable(false);
  grc::rs::mirror_enable(true);
  grc::rs::mirror_instance().set_root(kRootViewport, kRootCanvas, kIdentity);
  grc::rs::adopt_resources_begin(grc::rs::AdoptFault::None);
}

void stream_end() {
  grc::rs::adopt_resources_end();
  grc::rs::mirror_enable(false);
  fake::world().reset_calls();
  g_ctex_hook_calls.clear();
  g_multimesh_hook_calls.clear();
  g_multimesh_hook_args.clear();
  g_particles_hook_args.clear();
}

// The RenderingServer singleton, and texture_2d_get answering no image (a CanvasTexture, or a
// texture nothing can read back), with each RID it was asked for in `reads`.
void fake_rendering_server(std::vector<uint64_t> *reads) {
  fake::World &w = fake::world();
  w.singletons["RenderingServer"] = &w.make({"Object", "RenderingServer"});
  w.overrides["RenderingServer.texture_2d_get"] = [reads](fake::Object *, FakeArgs args, void *) {
    reads->push_back(fake::arg_u64(args, 0));
  };
}

void test_fake_binds() {
  fake::install();
  std::string missing;
  check(grc::rs::adopt_binds_ready(&missing), "fake: every bind resolves (" + missing + ")");
}

// a multimesh is adopted from the registry's
// recorded allocation, mesh, visible count and custom AABB, with only the buffer read back.
//   - 2d + custom and 3d (both 12 floats an instance, which PM9's stride guess read as 2d +
//     colors) reach the hook with their recorded format;
//   - an unregistered multimesh (pre-load) is refused `preload-multimesh` without a read;
//   - a buffer of another size than the allocation's is refused `buffer`, read once per stream;
//   - on the dummy host: an `edited` multimesh is refused without a read (O3), and an empty
//     buffer is the allocation's zeros;
//   - registry-mm-stride guesses again (the sabotage), registry-off refuses everything preload.
// A freed RID is forgotten and read again.
void test_multimesh_from_registry() {
  constexpr uint64_t kCustom = 0x7001, k3d = 0x7002, kPre = 0x7003, kEdited = 0x7004;
  constexpr uint64_t kBad = 0x7005, kEmpty = 0x7006, kMesh = 0x7010;
  fake::World &w = fake::world();
  std::vector<uint64_t> unused;
  std::map<uint64_t, std::vector<float>> buffers = {
      {kCustom, std::vector<float>(13 * 12, 1.0f)}, {k3d, std::vector<float>(14 * 12, 2.0f)},
      {kPre, std::vector<float>(2 * 8, 1.0f)},      {kEdited, std::vector<float>(2 * 8, 3.0f)},
      {kBad, std::vector<float>(7, 1.0f)},          {kEmpty, std::vector<float>()}};
  std::vector<uint64_t> reads;
  // stream_end() resets the fake world, so each stream installs the server again.
  const auto install = [&]() {
    fake_rendering_server(&unused);
    w.overrides["RenderingServer.multimesh_get_buffer"] = [&](fake::Object *, FakeArgs args,
                                                              void *ret) {
      const uint64_t rid = fake::arg_u64(args, 0);
      reads.push_back(rid);
      fake::put_packed_floats(ret, buffers[rid]);
    };
  };
  const auto record = [&]() {
    grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
    for (uint64_t rid : {kCustom, k3d, kEdited, kBad, kEmpty}) {
      grc::rs::registry_note_create(rid, grc::rs::RegistryKind::Multimesh);
    }
    grc::rs::registry_note_multimesh_allocate(kCustom, 13, 0, false, true, false);
    grc::rs::registry_note_multimesh_mesh(kCustom, kMesh);
    grc::rs::registry_note_multimesh_visible(kCustom, 9);
    grc::rs::registry_note_multimesh_allocate(k3d, 14, 1, false, false, false);
    grc::rs::registry_note_multimesh_allocate(kEdited, 2, 0, false, false, false);
    grc::rs::registry_note_multimesh_buffer(kEdited, 16);
    grc::rs::registry_note_multimesh_instance_edit(kEdited);
    grc::rs::registry_note_multimesh_allocate(kBad, 2, 0, false, false, false);
    grc::rs::registry_note_multimesh_allocate(kEmpty, 3, 0, true, false, false);
  };
  const auto begin = [&](grc::rs::AdoptFault f, bool dummy) {
    install();
    grc::rs::mirror_enable(false);
    grc::rs::mirror_enable(true);
    grc::rs::mirror_instance().set_root(kRootViewport, kRootCanvas, kIdentity);
    grc::rs::adopt_resources_begin(f, dummy);
    reads.clear();
  };

  // A GPU host (GLES3): every registered multimesh's buffer is the allocation's size.
  record();
  grc::rs::mirror_enable(false);
  begin(grc::rs::AdoptFault::None, false);
  grc::rs::materialize(kCustom, grc::rs::RefKind::Multimesh);
  grc::rs::materialize(k3d, grc::rs::RefKind::Multimesh);
  check(g_multimesh_hook_args.size() == 2 && g_multimesh_hook_args[0].rid == kCustom &&
            g_multimesh_hook_args[0].format == 0 && !g_multimesh_hook_args[0].colors &&
            g_multimesh_hook_args[0].custom && g_multimesh_hook_args[0].instances == 13 &&
            g_multimesh_hook_args[0].mesh == kMesh && g_multimesh_hook_args[0].visible == 9 &&
            g_multimesh_hook_args[0].floats == 13 * 12 && g_multimesh_hook_args[1].rid == k3d &&
            g_multimesh_hook_args[1].format == 1 && !g_multimesh_hook_args[1].colors &&
            !g_multimesh_hook_args[1].custom && g_multimesh_hook_args[1].instances == 14,
        "mm registry: 2d + custom and 3d handed over with the recorded allocation");
  grc::rs::materialize(kPre, grc::rs::RefKind::Multimesh);
  grc::rs::materialize(kPre, grc::rs::RefKind::Multimesh);
  check(reads == std::vector<uint64_t>({kCustom, k3d}) && g_multimesh_hook_args.size() == 2,
        "mm registry: an unregistered multimesh is refused without a read, once");
  grc::rs::materialize(kEdited, grc::rs::RefKind::Multimesh);
  check(g_multimesh_hook_args.size() == 3 && g_multimesh_hook_args[2].rid == kEdited &&
            g_multimesh_hook_args[2].first == 3.0f,
        "mm registry: edited on a GPU host: the getter's buffer is exact");
  grc::rs::materialize(kBad, grc::rs::RefKind::Multimesh);
  grc::rs::materialize(kBad, grc::rs::RefKind::Multimesh);
  grc::rs::materialize(kEmpty, grc::rs::RefKind::Multimesh);
  check(reads == std::vector<uint64_t>({kCustom, k3d, kEdited, kBad, kEmpty}) &&
            g_multimesh_hook_args.size() == 3,
        "mm registry: a buffer of the wrong size (or none, off the dummy) is refused, read once");
  grc::rs::AdoptResourceStats st = grc::rs::adopt_resource_stats();
  // The stub hook refuses kCustom, k3d and kEdited too (untyped).
  check(st.multimeshes == 0 && st.multimeshes_refused == 6 && st.refused_preload_multimesh == 1 &&
            st.refused_mm_buffer == 2 && st.refused_mm_edited_dummy == 0,
        "mm registry: typed refusals (preload 1, buffer 2)");
  grc::rs::adopt_resource_freed(kBad);
  grc::rs::materialize(kBad, grc::rs::RefKind::Multimesh);
  check(reads.back() == kBad && reads.size() == 6, "mm registry: a freed RID is read again");
  check(w.null_bind_calls == 0, "mm registry: no call through a null bind");
  stream_end();

  // The dummy host: edited is refused without a read (O3); never set is zeros.
  begin(grc::rs::AdoptFault::None, true);
  grc::rs::materialize(kEdited, grc::rs::RefKind::Multimesh);
  grc::rs::materialize(kEmpty, grc::rs::RefKind::Multimesh);
  check(reads == std::vector<uint64_t>({kEmpty}) && g_multimesh_hook_args.size() == 1 &&
            g_multimesh_hook_args[0].rid == kEmpty && g_multimesh_hook_args[0].floats == 3 * 12 &&
            g_multimesh_hook_args[0].first == 0.0f && g_multimesh_hook_args[0].colors,
        "mm dummy: edited refused unread, an unset buffer is the allocation's zeros");
  st = grc::rs::adopt_resource_stats();
  check(st.refused_mm_edited_dummy == 1 && st.refused_mm_buffer == 0,
        "mm dummy: typed edited-dummy");
  stream_end();

  // registry-mm-stride: the recorded format ignored, the 12-float stride read as 2d + colors.
  begin(grc::rs::AdoptFault::RegistryMmStride, false);
  grc::rs::materialize(kCustom, grc::rs::RefKind::Multimesh);
  grc::rs::materialize(k3d, grc::rs::RefKind::Multimesh);
  check(g_multimesh_hook_args.size() == 2 && g_multimesh_hook_args[0].format == 0 &&
            g_multimesh_hook_args[0].colors && !g_multimesh_hook_args[0].custom &&
            g_multimesh_hook_args[1].format == 0 && g_multimesh_hook_args[1].colors &&
            g_multimesh_hook_args[1].instances == 14,
        "mm registry-mm-stride: both misread as 2d + colors (the count kept)");
  stream_end();

  // LAR6: an off-main reference is queued once (deduplicated), not read on its thread, and
  // materialized by the frame drain on the main thread; a freed one is skipped.
  begin(grc::rs::AdoptFault::None, false);
  {
    bool r1 = true, r2 = true, r3 = true;
    std::thread t([&]() {
      r1 = grc::rs::materialize(kCustom, grc::rs::RefKind::Multimesh);
      r2 = grc::rs::materialize(kCustom, grc::rs::RefKind::Multimesh);
      r3 = grc::rs::materialize(k3d, grc::rs::RefKind::Multimesh);
    });
    t.join();
    st = grc::rs::adopt_resource_stats();
    check(!r1 && !r2 && !r3 && reads.empty() && g_multimesh_hook_args.empty() &&
              st.offmain_queued == 2,
          "queue: off-main references queued once each, unread");
    grc::rs::adopt_resource_freed(k3d);
    grc::rs::adopt_frame_drain();
    st = grc::rs::adopt_resource_stats();
    check(reads == std::vector<uint64_t>({kCustom}) && g_multimesh_hook_args.size() == 1 &&
              st.offmain_drained == 1 && st.offmain_dropped == 1,
          "queue: the drain adopts on the main thread, a freed entry skipped");
    // (this file's hooks_adopt_multimesh stub registers nothing, so the entry is then refused)
    grc::rs::adopt_frame_drain();
    check(grc::rs::adopt_resource_stats().offmain_drained == 1, "queue: drained once");
  }
  stream_end();
  // registry-queue-drop: the drain discards the queue.
  begin(grc::rs::AdoptFault::RegistryQueueDrop, false);
  {
    std::thread t([&]() { grc::rs::materialize(kCustom, grc::rs::RefKind::Multimesh); });
    t.join();
    grc::rs::adopt_frame_drain();
    st = grc::rs::adopt_resource_stats();
    check(reads.empty() && g_multimesh_hook_args.empty() && st.offmain_queued == 1 &&
              st.offmain_dropped == 1 && st.offmain_drained == 0,
          "queue registry-queue-drop: the queued reference is lost");
  }
  stream_end();

  // registry-off: nothing recorded, so every multimesh is preload.
  grc::rs::registry_configure(true, grc::rs::RegistryFault::Off);
  begin(grc::rs::AdoptFault::RegistryOff, false);
  grc::rs::materialize(kCustom, grc::rs::RefKind::Multimesh);
  grc::rs::materialize(k3d, grc::rs::RefKind::Multimesh);
  st = grc::rs::adopt_resource_stats();
  check(reads.empty() && g_multimesh_hook_args.empty() && st.refused_preload_multimesh == 2,
        "mm registry-off: every multimesh refused preload, unread");
  stream_end();
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
}

// LAR1: CanvasTextures adopted from the registry share atlas pages. No getter runs on a registered
// CanvasTexture's own RID (its kind is the registry's), a channel texture the mirror already knows
// is never read back, and one this stream refused is read once across every CanvasTexture that
// names it.
void test_canvas_texture_channels_not_reread() {
  constexpr uint64_t kCtexA = 0x8001, kCtexB = 0x8002, kKnown = 0x8010;
  constexpr uint64_t kCtexC = 0x8003, kCtexD = 0x8004, kUnreadable = 0x8011;
  fake::World &w = fake::world();
  std::vector<uint64_t> reads;
  fake_rendering_server(&reads);
  // GRC_ADOPT=arm: the registry records from the vptr store, before the arm (mirror disabled).
  grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
  grc::rs::mirror_enable(false);
  for (uint64_t ctex : {kCtexA, kCtexB}) {
    grc::rs::registry_note_create(ctex, grc::rs::RegistryKind::CanvasTexture);
    grc::rs::registry_note_canvas_channel(ctex, 0, kKnown);
  }
  for (uint64_t ctex : {kCtexC, kCtexD}) {
    grc::rs::registry_note_create(ctex, grc::rs::RegistryKind::CanvasTexture);
    grc::rs::registry_note_canvas_channel(ctex, 0, kUnreadable);
  }
  stream_begin();
  Mirror &m = grc::rs::mirror_instance();
  m.texture_2d_create(kKnown, rgba_copy(kHashA), some_bytes(), 1);  // the shared, known diffuse
  check(m.knows_texture(kKnown), "ctex: the shared diffuse is known");
  grc::rs::materialize(kCtexA, grc::rs::RefKind::Texture);
  grc::rs::materialize(kCtexB, grc::rs::RefKind::Texture);
  check(reads.empty(),
        "ctex: no texture_2d_get on a registered CanvasTexture, nor on the known diffuse");
  check(g_ctex_hook_calls.size() == 2 && g_ctex_hook_calls[0].rid == kCtexA &&
            g_ctex_hook_calls[0].diffuse == kKnown && g_ctex_hook_calls[1].rid == kCtexB &&
            g_ctex_hook_calls[1].diffuse == kKnown,
        "ctex: both handed to the hook from the registry, with the shared diffuse");
  grc::rs::materialize(kCtexC, grc::rs::RefKind::Texture);
  grc::rs::materialize(kCtexD, grc::rs::RefKind::Texture);
  check(reads == std::vector<uint64_t>({kUnreadable}),
        "ctex: an unreadable diffuse is read once across both CanvasTextures");
  const grc::rs::AdoptResourceStats st = grc::rs::adopt_resource_stats();
  check(st.textures_refused == 5 && st.refused_no_image == 1 && st.refused_canvas_empty == 0,
        "ctex: four CanvasTextures (the stub hook refuses) and the diffuse refused (no-image)");
  reads.clear();
  grc::rs::materialize(kCtexA, grc::rs::RefKind::Texture);
  grc::rs::materialize(kUnreadable, grc::rs::RefKind::Texture);
  check(reads.empty(), "ctex: a refused RID is not read again by a later reference");
  check(w.null_bind_calls == 0, "ctex: no call through a null bind");
  stream_end();
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
}

// LAR1 (design R1, R5): the registry records armed or not -- a CanvasTexture created after the
// arm, and a set_* call after it, are recorded like pre-arm ones -- with filter and repeat; a free
// erases the entry (the freed RID then takes the residual path); a registered CanvasTexture with
// no diffuse is refused typed `canvas-empty`. With GRC_ADOPT=off or registry-off the gate is closed.
void test_canvas_texture_registry_gating() {
  constexpr uint64_t kPre = 0x8101, kPreDiffuse = 0x8111, kNew = 0x8102, kNewDiffuse = 0x8112;
  constexpr uint64_t kFreed = 0x8103, kFreedDiffuse = 0x8113, kEmpty = 0x8104;
  fake::World &w = fake::world();
  std::vector<uint64_t> reads;
  fake_rendering_server(&reads);
  grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
  grc::rs::mirror_enable(false);
  grc::rs::registry_note_create(kPre, grc::rs::RegistryKind::CanvasTexture);  // pre-arm
  grc::rs::registry_note_create(kFreed, grc::rs::RegistryKind::CanvasTexture);
  grc::rs::registry_note_canvas_channel(kFreed, 0, kFreedDiffuse);
  grc::rs::registry_note_create(kEmpty, grc::rs::RegistryKind::CanvasTexture);
  stream_begin();
  grc::rs::registry_note_create(kNew, grc::rs::RegistryKind::CanvasTexture);  // armed
  grc::rs::registry_note_canvas_channel(kNew, 0, kNewDiffuse);
  grc::rs::registry_note_canvas_channel(kPre, 0, kPreDiffuse);  // armed, on a pre-arm entry
  grc::rs::registry_note_canvas_filter(kPre, 1);
  grc::rs::registry_note_canvas_repeat(kPre, 2);
  grc::rs::registry_note_free(kFreed);
  grc::rs::adopt_resource_freed(kFreed);
  grc::rs::materialize(kNew, grc::rs::RefKind::Texture);
  check(reads == std::vector<uint64_t>({kNewDiffuse}) && g_ctex_hook_calls.size() == 1 &&
            g_ctex_hook_calls[0].rid == kNew && g_ctex_hook_calls[0].diffuse == kNewDiffuse,
        "registry: a post-arm create is recorded (its diffuse read, then the hook)");
  grc::rs::materialize(kPre, grc::rs::RefKind::Texture);
  check(reads == std::vector<uint64_t>({kNewDiffuse, kPreDiffuse}) &&
            g_ctex_hook_calls.size() == 2 && g_ctex_hook_calls[1].rid == kPre &&
            g_ctex_hook_calls[1].diffuse == kPreDiffuse && g_ctex_hook_calls[1].filter == 1 &&
            g_ctex_hook_calls[1].repeat == 2,
        "registry: post-arm setters update the pre-arm entry, filter and repeat included");
  grc::rs::materialize(kFreed, grc::rs::RefKind::Texture);
  check(reads.size() == 3 && reads.back() == kFreed && g_ctex_hook_calls.size() == 2,
        "registry: a freed CanvasTexture's entry is gone (the residual path reads its RID)");
  grc::rs::materialize(kEmpty, grc::rs::RefKind::Texture);
  check(reads.size() == 3 && g_ctex_hook_calls.size() == 2,
        "registry: a CanvasTexture with no diffuse is neither read nor handed over");
  const grc::rs::AdoptResourceStats st = grc::rs::adopt_resource_stats();
  check(st.textures_refused == 6 && st.refused_no_image == 3 && st.refused_canvas_empty == 1 &&
            st.canvas_registry == 0 && st.canvas_residual == 0,
        "registry: kNew, kPre (the stub hook), both diffuses and kFreed (no-image), kEmpty "
        "(canvas-empty) refused");
  check(w.null_bind_calls == 0, "registry: no call through a null bind");
  stream_end();
  // GRC_ADOPT=off, and registry-off: the hooks' gate is closed, so nothing is recorded.
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
  check(!grc::rs::registry_on(), "registry: GRC_ADOPT=off closes the gate");
  grc::rs::registry_configure(true, grc::rs::RegistryFault::Off);
  check(!grc::rs::registry_on(), "registry: registry-off closes the gate");
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
}

// LATE-RES: a post-arm emitter drawing with a pre-arm ParticleProcessMaterial is
// `unknown-material`; adopt_particles_resolve adopts it through the node map (adopt_ppm: LAR4, the
// registry, else the placeholder keyed from the material's getters). A failed adoption is refused
// for the stream: the emitter's next draw queues it again, and the resolve reaches its node but
// does not read the material again. A freed material RID is forgotten. LAR4: the resolve is
// driven by the mirror's queue, so a frame that queued nothing reaches no node.
void test_refused_ppm_not_retried() {
  constexpr uint64_t kItem = 0x40, kEmitter = 0x900, kMaterial = 0x777;
  fake::World &w = fake::world();
  std::vector<uint64_t> unused;
  fake_rendering_server(&unused);
  // The scene: SceneTree > root Viewport > a GPUParticles2D (item kItem) whose process material
  // is a ParticleProcessMaterial the mirror never saw.
  fake::Object &engine = w.make({"Object", "Engine"});
  fake::Object &tree = w.make({"Object", "MainLoop", "SceneTree"});
  fake::Object &root = w.make({"Object", "Node", "Viewport", "Window"});
  fake::Object &node = w.make({"Object", "Node", "CanvasItem", "Node2D", "GPUParticles2D"}, kItem);
  fake::Object &material =
      w.make({"Object", "RefCounted", "Resource", "Material", "ParticleProcessMaterial"}, kMaterial);
  node.canvas = kRootCanvas;
  w.adopt_child(root, node);
  w.singletons["Engine"] = &engine;
  w.overrides["Engine.get_main_loop"] = [&tree](fake::Object *, FakeArgs, void *ret) {
    fake::put_object(ret, &tree);
  };
  w.overrides["SceneTree.get_root"] = [&root](fake::Object *, FakeArgs, void *ret) {
    fake::put_object(ret, &root);
  };
  w.overrides["GPUParticles2D.get_process_material"] = [&material](fake::Object *, FakeArgs,
                                                                   void *ret) {
    fake::put_object(ret, &material);  // a Ref<Material> slot
  };
  stream_begin();
  grc::rs::AdoptConfig config;
  const AdoptStats arm = grc::rs::adopt_at_arm(config);  // the walk maps kItem to the node
  check(arm.error.empty() && arm.items == 1 && grc::rs::adopted_item_nodes().count(kItem) == 1,
        "ppm: the walk adopts the emitter's item and maps its node (" + arm.error + ")");
  Mirror &m = grc::rs::mirror_instance();
  Mirror::ParticlesOptions options;
  options.enabled = true;
  m.set_particles(options);
  grc::rs::adopt_materials_configure(grc::rs::AdoptMaterialSabotage::None);  // LAR4: the queues
  grc::rs::adopt_materials_at_arm();  // the arm's material pass (resolves the node map's tags)
  // Post-arm: the emitter is created under the hooks and given the pre-arm material.
  Mirror::ParticlesArgs mode;
  m.particles_create(kEmitter, 2);
  m.particles_call(kEmitter, Mirror::ParticlesOp::SetMode, mode, 2);
  Mirror::ParticlesArgs pm;
  pm.rid = kMaterial;
  m.particles_call(kEmitter, Mirror::ParticlesOp::SetProcessMaterial, pm, 2);
  m.add_particles(kItem, kEmitter, 0, 2);
  check(m.ppm_resolve_candidates().unknown_material.size() == 1,
        "ppm: the emitter is an unknown-material candidate");
  // No adopt_particles_ref primes the PM7 binds: the LATE-RES resolve resolves them itself (it
  // once read through null binds when no pre-arm emitter had been adopted yet).
  check(m.has_pending_ppm(), "ppm: the set and the draw queued the emitter");
  const char *kRead = "ParticleProcessMaterial.get_emission_shape";  // ppm_key's first getter
  grc::rs::adopt_particles_resolve();
  check(!m.has_pending_ppm() && m.ppm_scans() == 0,
        "ppm: the drain empties the queue, with the drawing item from the draw (no item walk)");
  check(w.count(kRead) == 1 && w.count("Resource.duplicate") == 0 &&
            grc::rs::adopt_emitter_stats().ppm_refused == 1 &&
            grc::rs::adopt_emitter_stats().ppm_refused_no_shader == 1,
        "ppm: the first resolve tries the unregistered material once (the placeholder, no "
        "duplicate) and refuses it");
  grc::rs::adopt_particles_resolve();
  check(w.count("GPUParticles2D.get_process_material") == 1,
        "ppm: a frame that queued nothing reaches no node");
  m.clear(kItem, 3);  // the emitter's next redraw (clear, add_particles) queues it again
  m.add_particles(kItem, kEmitter, 0, 3);
  grc::rs::adopt_particles_resolve();
  check(w.count("GPUParticles2D.get_process_material") == 2,
        "ppm: the second resolve still reaches the emitter's node");
  check(w.count(kRead) == 1 && grc::rs::adopt_emitter_stats().ppm_refused == 1,
        "ppm: the refused material is not read again");
  grc::rs::adopt_resource_freed(kMaterial);
  m.clear(kItem, 4);
  m.add_particles(kItem, kEmitter, 0, 4);
  grc::rs::adopt_particles_resolve();
  check(w.count(kRead) == 2, "ppm: a freed material RID is forgotten");
  check(w.null_bind_calls == 0, "ppm: no call through a null bind");
  stream_end();
}

// a pre-arm emitter is adopted from the registry's record
// alone -- no node, no getter, no draw note: the configuration, floats and trail poses as the
// setters declared them, the recorded draw passes and process material. An unregistered emitter
// is refused, typed preload-particles, once.
void test_particles_from_registry() {
  constexpr uint64_t kEmitter = 0x8001, kPre = 0x8002, kMat = 0x8010, kMesh = 0x8011;
  fake::World &w = fake::world();
  std::vector<uint64_t> unused;
  fake_rendering_server(&unused);
  using R = grc::rs::RegistryParticlesOp;
  grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
  grc::rs::registry_note_create(kEmitter, grc::rs::RegistryKind::Particles);
  grc::rs::registry_note_particles(kEmitter, R::Mode, 0, 0, nullptr, 0);  // PARTICLES_MODE_2D
  grc::rs::registry_note_particles(kEmitter, R::Emitting, 1, 0, nullptr, 0);
  grc::rs::registry_note_particles(kEmitter, R::Amount, 9, 0, nullptr, 0);
  grc::rs::registry_note_particles(kEmitter, R::Seed, 1901, 0, nullptr, 0);
  grc::rs::registry_note_particles(kEmitter, R::TransformAlign, 2, 0, nullptr, 0);
  const float lifetime = 1.5f, collision = 3.0f, length = 0.25f;
  grc::rs::registry_note_particles(kEmitter, R::Floats, 1, 0, &lifetime, 1);
  grc::rs::registry_note_particles(kEmitter, R::Floats, 6, 0, &collision, 1);
  grc::rs::registry_note_particles(kEmitter, R::Trails, 1, 0, &length, 1);
  const std::vector<float> poses(24, 0.5f);
  grc::rs::registry_note_particles(kEmitter, R::TrailBindPoses, 0, 0, poses.data(), poses.size());
  grc::rs::registry_note_particles(kEmitter, R::DrawPasses, 1, 0, nullptr, 0);
  grc::rs::registry_note_particles(kEmitter, R::DrawPassMesh, 0, kMesh, nullptr, 0);
  grc::rs::registry_note_particles(kEmitter, R::ProcessMaterial, 0, kMat, nullptr, 0);
  stream_begin();
  Mirror::ParticlesOptions options;
  options.enabled = true;
  grc::rs::mirror_instance().set_particles(options);
  grc::rs::materialize(kEmitter, grc::rs::RefKind::Particles);
  check(g_particles_hook_args.size() == 1 && g_particles_hook_args[0].first == kEmitter,
        "pt registry: the registered emitter is handed over");
  if (g_particles_hook_args.size() == 1) {
    const Mirror::ParticlesAdopt &a = g_particles_hook_args[0].second;
    check(a.mode_2d && a.emitting && a.amount == 9 && a.seed == 1901 && a.transform_align == 2 &&
              a.trails && a.fixed_fps == 30 && a.interpolate && a.floats.size() == 31 + 24 &&
              a.floats[1] == 1.5f && a.floats[6] == 3.0f && a.floats[7] == 0.25f &&
              a.floats[0] == 1.0f && a.floats[31] == 0.5f &&
              a.passes == std::vector<uint64_t>({kMesh}) && a.material == kMat &&
              a.subemitter == 0,
          "pt registry: the recorded configuration, floats, poses, pass and material");
  }
  check(w.count("GPUParticles2D.get_amount") == 0 && w.count("Node.can_process") == 0,
        "pt registry: no emitter getter is read");
  grc::rs::materialize(kPre, grc::rs::RefKind::Particles);
  grc::rs::materialize(kPre, grc::rs::RefKind::Particles);
  const grc::rs::EmitterAdoptStats st = grc::rs::adopt_emitter_stats();
  check(g_particles_hook_args.size() == 1 && st.refused == 1 && st.refused_preload_particles == 1,
        "pt registry: an unregistered emitter is refused once, typed preload-particles");
  stream_end();
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
}

void test_htr_restore() {
  auto &w = fake::world();
  const auto saved = grc::g_iface;
  static std::vector<uint8_t> packed;
  grc::g_iface.variant_get_ptr_constructor = [](GDExtensionVariantType, int32_t) -> GDExtensionPtrConstructor {
    return +[](GDExtensionUninitializedTypePtr, const GDExtensionConstTypePtr *) {};
  };
  grc::g_iface.variant_get_ptr_builtin_method = [](GDExtensionVariantType, GDExtensionConstStringNamePtr,
                                                  GDExtensionInt) -> GDExtensionPtrBuiltInMethod {
    return +[](GDExtensionTypePtr, const GDExtensionConstTypePtr *args, GDExtensionTypePtr ret, int) {
      packed.resize(*static_cast<const int64_t *>(args[0]));
      fake::put_int(ret, 0);
    };
  };
  grc::g_iface.get_proc_address = [](const char *) -> GDExtensionInterfaceFunctionPtr {
    return reinterpret_cast<GDExtensionInterfaceFunctionPtr>(
        +[](GDExtensionTypePtr, GDExtensionInt i) -> uint8_t * { return packed.data() + i; });
  };
  grc::g_iface.string_to_utf8_chars = [](GDExtensionConstStringPtr str, char *out, GDExtensionInt n) -> GDExtensionInt {
    const auto &text = *static_cast<const std::string *>(str);
    if (out) std::memcpy(out, text.data(), std::min<size_t>(n, text.size()));
    return text.size();
  };
  // main body, block variant, missing source, mismatched source, existing image, failed write,
  // fault, shutdown, non-dummy, valid path, invalid path, null image, coded source, wrong format,
  // finished job's main body, finished job's block variant, mispredicted finished job.
  for (int action = 0; action < 17; ++action) {
    constexpr uint64_t rid = 0xabcd9876;
    grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
    grc::rs::registry_note_texture_create(rid, {64, 64, 17, false, true}, true);
    if (action == 9 || action == 10) grc::rs::registry_note_texture_path(
        rid, std::make_shared<const std::string>(action == 9 ? "res://ok.ctex" : "res://scene::image"));
    auto &image = w.make({"Object", "Image"});
    w.singletons["RenderingServer"] = &w.make({"Object", "RenderingServer"});
    int64_t size = action == 4 ? 32 : 1, format = action == 4 ? 17 : 0;
    int writes = 0, reads = 0;
    w.overrides["RenderingServer.texture_2d_get"] = [&](fake::Object *, FakeArgs args, void *ret) {
      ++reads;
      check(fake::arg_u64(args, 0) == rid, "restore: getter names original texture");
      fake::put_object(ret, action == 11 ? nullptr : &image);
    };
    w.overrides["Image.get_width"] = [&](fake::Object *, FakeArgs, void *ret) { fake::put_int(ret, size); };
    w.overrides["Image.get_height"] = w.overrides["Image.get_width"];
    w.overrides["Image.get_format"] = [&](fake::Object *, FakeArgs, void *ret) { fake::put_int(ret, format); };
    w.overrides["Image.has_mipmaps"] = [](fake::Object *, FakeArgs, void *ret) { *static_cast<uint8_t *>(ret) = 0; };
    w.overrides["Image.set_data"] = [&](fake::Object *obj, FakeArgs args, void *) {
      ++writes;
      check(obj == &image && fake::arg_u64(args, 0) == 64 && fake::arg_u64(args, 1) == 64 &&
            *static_cast<const uint8_t *>(args[2]) == 0 && fake::arg_u64(args, 3) == 17,
            "restore: Image.set_data uses original image and typed shape arguments");
      check(packed == std::vector<uint8_t>(2048, 0x5a), "restore: exact source bytes copied");
      if (action != 5) { size = 64; format = 17; }
    };
    grc::rs::mirror_enable(false);
    grc::rs::mirror_enable(true);
    auto &mirror = grc::rs::mirror_instance();
    grc::rs::PayloadCopy copy;
    copy.status = "ok"; copy.format = 17; copy.width = 64; copy.height = 64;
    copy.hash = std::string(64, 'a'); copy.data_bytes = 2048;
    std::vector<uint8_t> data(2048, 0x5a);
    auto body = std::make_shared<grc::rs::PayloadBytes>(grc::rs::encode_payload(
        17, action == 3 ? 32 : 64, 64, false, data.data(), data.size()));
    grc::rs::PayloadPtr main = body;
    if (action == 12) {
      grc::rs::set_rest_config({grc::rs::RestCoding::Zstd, false});
      grc::rs::code_at_rest(&main);
      check(main->rest == grc::rs::RestCoding::Zstd, "restore: test source is coded at rest");
      grc::rs::reset_rest_stats();
    }
    if (action == 13) copy.format = 5;
    if (action == 1) { copy.format = 5; copy.block_format = "DXT1"; copy.block_bytes = body; main.reset(); }
    if (action >= 14) {
      if (action == 15) copy.format = 5;
      auto job = std::make_shared<grc::rs::TextureJob>(copy);
      mirror.texture_2d_create(rid, copy, nullptr, 0, job);
      auto actual = copy;
      if (action == 15) {
        actual.block_format = "DXT1";
        actual.block_bytes = body;
        std::vector<uint8_t> rgba(64 * 64 * 4, 0x7f);
        main = std::make_shared<grc::rs::PayloadBytes>(grc::rs::encode_payload(
            5, 64, 64, false, rgba.data(), rgba.size()));
      }
      if (action == 16) actual.width = 32;
      job->finish(actual, main);
      check(job->done() && job->mispredict() == (action == 16),
            "restore: finished job has expected prediction status before any settle");
    } else if (action != 2) mirror.texture_2d_create(rid, copy, main, 0);
    grc::rs::adopt_resources_begin(grc::rs::AdoptFault::None, action != 8);
    const auto stats = grc::rs::adopt_htr_restore(
        action == 6 ? grc::rs::AdoptFault::SkipHtrRestore : grc::rs::AdoptFault::None, action == 7);
    const bool restored = action == 0 || action == 1 || action == 10 || action == 12 ||
                          action == 14 || action == 15;
    check(stats.candidates == (action == 9 ? 0u : 1u), "restore: only released non-reloadable paths qualify");
    check(stats.restored == (restored ? 1u : 0u), "restore: source restored only after verified write");
    check(stats.unavailable == (action == 2 || action == 11 || action == 13 || action == 16 ? 1u : 0u), "restore: unavailable body/image counted");
    check(stats.mismatch == (action == 3 || action == 5 ? 1u : 0u), "restore: source and read-back mismatch counted");
    check(stats.not_placeholder == (action == 4 ? 1u : 0u), "restore: existing non-placeholder untouched");
    check(stats.skipped_fault == (action == 6 ? 1u : 0u) && stats.skipped_shutdown == (action == 7 ? 1u : 0u),
          "restore: fault and shutdown candidates counted");
    check(reads == (restored || action == 4 || action == 5 || action == 11 ? 1 : 0),
          "restore: no engine getter on skipped or invalid source");
    check(writes == (restored || action == 5 ? 1 : 0), "restore: no overwrite outside placeholder");
    if (action == 12) check(grc::rs::rest_stats().inflate[
        static_cast<size_t>(grc::rs::InflateSite::Restore)].count == 1 &&
        std::string(grc::rs::inflate_site_name(grc::rs::InflateSite::Restore)) == "restore",
        "restore: coded source inflates at the restore site");
    grc::rs::RegistryTextureRecord record;
    check(grc::rs::registry_texture(rid, &record) && record.released == !restored,
          "restore: clears released only after successful read-back");
    grc::rs::adopt_resources_end(); grc::rs::adopt_release(); w.reset_calls();
  }
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
  check(grc::rs::adopt_htr_restore(grc::rs::AdoptFault::None).skipped == "registry-off",
        "restore: registry-off skips without engine calls");
  grc::rs::set_rest_config({});
  grc::g_iface = saved;
}

void test_evict_duplicate_rid() {
  auto &w = fake::world();
  const auto saved = grc::g_iface;
  static std::vector<uint8_t> packed;
  grc::g_iface.variant_get_ptr_constructor = [](GDExtensionVariantType, int32_t) -> GDExtensionPtrConstructor {
    return +[](GDExtensionUninitializedTypePtr, const GDExtensionConstTypePtr *) {};
  };
  grc::g_iface.variant_get_ptr_builtin_method = [](GDExtensionVariantType, GDExtensionConstStringNamePtr,
                                                  GDExtensionInt) -> GDExtensionPtrBuiltInMethod {
    return +[](GDExtensionTypePtr, const GDExtensionConstTypePtr *args, GDExtensionTypePtr ret, int) {
      packed.resize(*static_cast<const int64_t *>(args[0]));
      fake::put_int(ret, 0);
    };
  };
  grc::g_iface.get_proc_address = [](const char *) -> GDExtensionInterfaceFunctionPtr {
    return reinterpret_cast<GDExtensionInterfaceFunctionPtr>(
        +[](GDExtensionTypePtr, GDExtensionInt i) -> uint8_t * { return packed.data() + i; });
  };
  grc::g_iface.string_to_utf8_chars = [](GDExtensionConstStringPtr str, char *out, GDExtensionInt n) -> GDExtensionInt {
    const auto &text = *static_cast<const std::string *>(str);
    if (out) std::memcpy(out, text.data(), std::min<size_t>(n, text.size()));
    return text.size();
  };
  for (const bool shrink_fails : {false, true}) {
    constexpr uint64_t rid = 0xabcd9877;
    constexpr int64_t data_bytes = 4096;
    grc::rs::mirror_enable(false);
    grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
    grc::rs::registry_note_texture_create(rid, {64, 64, 19, false, true}, false);
    grc::rs::registry_note_texture_path(rid, std::make_shared<const std::string>("res://duplicate.ctex"));
    grc::rs::evict_configure(true, true, "active", "");
    auto &image = w.make({"Object", "Image"});
    w.singletons["RenderingServer"] = &w.make({"Object", "RenderingServer"});
    int64_t size = 64, format = 19;
    int writes = 0;
    w.overrides["RenderingServer.texture_2d_get"] = [&](fake::Object *, FakeArgs args, void *ret) {
      check(fake::arg_u64(args, 0) == rid, "evict duplicate: getter names original texture");
      fake::put_object(ret, &image);
    };
    w.overrides["Image.get_width"] = [&](fake::Object *, FakeArgs, void *ret) { fake::put_int(ret, size); };
    w.overrides["Image.get_height"] = w.overrides["Image.get_width"];
    w.overrides["Image.get_format"] = [&](fake::Object *, FakeArgs, void *ret) { fake::put_int(ret, format); };
    w.overrides["Image.has_mipmaps"] = [](fake::Object *, FakeArgs, void *ret) { *static_cast<uint8_t *>(ret) = 0; };
    w.overrides["Image.get_data_size"] = [](fake::Object *, FakeArgs, void *ret) { fake::put_int(ret, data_bytes); };
    w.overrides["Image.set_data"] = [&](fake::Object *obj, FakeArgs args, void *) {
      ++writes;
      check(obj == &image && fake::arg_u64(args, 0) == 1 && fake::arg_u64(args, 1) == 1 &&
            *static_cast<const uint8_t *>(args[2]) == 0 && fake::arg_u64(args, 3) == 0,
            "evict duplicate: shrink uses typed 1x1 L8 arguments");
      check(packed == std::vector<uint8_t>(1, 0), "evict duplicate: shrink uses one zero byte");
      if (!shrink_fails) { size = 1; format = 0; }
    };
    grc::rs::evict_queue().note(rid, 7);
    grc::rs::evict_queue().note(rid, 7);
    const auto drained = grc::rs::adopt_evict_drain(32, 8);
    const auto &stats = grc::rs::evict_stats();
    check(drained.examined == 2 && stats.examined == 2, "evict duplicate: both notifications examined");
    check(drained.released == (shrink_fails ? 0u : 1u) && stats.released == drained.released,
          "evict duplicate: one release per RID");
    check(stats.released_bytes == (shrink_fails ? 0u : data_bytes), "evict duplicate: bytes counted once");
    check(stats.rss_measured_bytes == stats.released_bytes, "evict duplicate: RSS measured bytes counted once");
    check(stats.skipped[static_cast<size_t>(grc::rs::EvictSkip::AlreadyReleased)] == (shrink_fails ? 0u : 1u),
          "evict duplicate: second successful notification already released");
    check(stats.skipped[static_cast<size_t>(grc::rs::EvictSkip::ShrinkFailed)] == (shrink_fails ? 2u : 0u),
          "evict duplicate: failed shrink applies to both notifications");
    check(stats.releases.size() == (shrink_fails ? 0u : 1u), "evict duplicate: one release record per RID");
    check(writes == 1, "evict duplicate: one shrink attempt per RID");
    check(grc::rs::evict_balanced(stats), "evict duplicate: balanced accounting");
    w.reset_calls();
  }
  grc::rs::evict_configure(false, false, "off", "");
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
  grc::g_iface = saved;
}

void test_reload_sources() {
  auto &w = fake::world();
  const auto saved = grc::g_iface;
  grc::g_iface.variant_get_ptr_constructor = [](GDExtensionVariantType, int32_t) -> GDExtensionPtrConstructor {
    return +[](GDExtensionUninitializedTypePtr, const GDExtensionConstTypePtr *) {};
  };
  grc::g_iface.variant_get_ptr_builtin_method = [](GDExtensionVariantType, GDExtensionConstStringNamePtr,
                                                  GDExtensionInt) -> GDExtensionPtrBuiltInMethod {
    return +[](GDExtensionTypePtr, const GDExtensionConstTypePtr *, GDExtensionTypePtr, int) {};
  };
  grc::g_iface.get_proc_address = [](const char *) -> GDExtensionInterfaceFunctionPtr {
    return reinterpret_cast<GDExtensionInterfaceFunctionPtr>(+[]() {});
  };
  grc::g_iface.string_to_utf8_chars = [](GDExtensionConstStringPtr str, char *out, GDExtensionInt n) -> GDExtensionInt {
    const auto &text = *static_cast<const std::string *>(str);
    if (out) std::memcpy(out, text.data(), std::min<size_t>(n, text.size()));
    return text.size();
  };
  for (int scenario = 0; scenario < 14; ++scenario) {
    const bool warm = scenario >= 5;
    const int action = scenario == 10 ? 0 : scenario >= 12 ? 2 : scenario % 5;
    constexpr uint64_t rid = 0xabcd1234, temp = 0xabcd1235;
    grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
    grc::rs::registry_note_texture_create(rid, {64, 64, 17, false, true}, true);
    auto path = std::make_shared<const std::string>("res://source.ctex");
    grc::rs::registry_note_texture_path(rid, path);
    auto &image = w.make({"Object", "Image"});
    auto &resource = w.make({"Object", "Resource", "CompressedTexture2D"}, temp);
    w.singletons["ResourceLoader"] = &w.make({"Object", "ResourceLoader"});
    w.singletons["RenderingServer"] = &w.make({"Object", "RenderingServer"});
    w.overrides["ResourceLoader.load"] = [&](fake::Object *, FakeArgs args, void *ret) {
      check(args[0] == path.get() && fake::arg_u64(args, 2) == 0, "reload: held String and ignore-cache mode");
      fake::put_object(ret, &resource);
    };
    w.overrides["RenderingServer.texture_2d_get"] = [&](fake::Object *, FakeArgs args, void *ret) {
      check(fake::arg_u64(args, 0) == temp, "reload: materialize consumes source without original getter");
      fake::put_object(ret, &image);
    };
    w.overrides["Image.get_width"] = [](fake::Object *, FakeArgs, void *ret) { fake::put_int(ret, 64); };
    w.overrides["Image.get_height"] = w.overrides["Image.get_width"];
    w.overrides["Image.get_format"] = [](fake::Object *, FakeArgs, void *ret) { fake::put_int(ret, 17); };
    w.overrides["Image.has_mipmaps"] = [](fake::Object *, FakeArgs, void *ret) { *static_cast<uint8_t *>(ret) = 0; };
    grc::rs::mirror_enable(false);
    grc::rs::mirror_enable(true);
    grc::rs::adopt_resources_begin(grc::rs::AdoptFault::None, true);
    g_reload_scope_allowed = true;
    g_reload_adopt_image = nullptr;
    const auto stats = grc::rs::adopt_reload_at_arm();
    check(stats.reloaded == 1 && stats.held_bytes == 2048 && stats.refused.total() == 0 &&
              stats.temp_outlived == 0 && grc::rs::adopt_reload_sources_held() == 1,
          "reload: verified source retained with compressed byte accounting");
    if (warm) {
      if (scenario == 10) grc::rs::registry_note_free(rid);
      const auto queued = grc::rs::adopt_warm_at_arm(grc::rs::warm_now_ns(), "sync");
      check(queued.queued == 1 && queued.from_reload == 1 && queued.reload_sources_left == 0 &&
                queued.warm_complete && grc::rs::adopt_reload_sources_held() == 0,
            "warm reload: registered and residual sources are prepared and released at the arm");
      check(g_reload_adopt_image == nullptr, "warm reload: preparing a body does not publish it");
    }
    if (action == 0) {
      g_reload_adopt = true;
      grc::rs::materialize(rid, grc::rs::RefKind::Texture);
      check(g_reload_adopt_image == &image && grc::rs::adopt_resource_stats().textures_reload == 1,
            "reload: original held Image adopted as current");
      check(grc::rs::adopt_reload_json(1, 1).find("\"adopted\": true") != std::string::npos,
            "reload: source entry marked adopted");
      g_reload_adopt = false;
    } else if (action == 1) {
      const bool superseded = scenario == 11;
      if (superseded) {
        grc::rs::PayloadCopy copy;
        copy.status = "ok";
        grc::rs::mirror_instance().texture_2d_create(rid, copy, nullptr, 0);
      }
      check(grc::rs::mirror_instance().knows_texture(rid) == superseded,
            "warm free: mirror distinguishes an update adoption from an unknown texture");
      grc::rs::adopt_resource_freed(rid);
      grc::rs::adopt_resource_freed(rid);
      if (warm) grc::rs::adopt_warm_finish();
      grc::rs::adopt_reload_finish();
      check(grc::rs::adopt_reload_json(1, 1).find("\"dropped_freed\": 1") != std::string::npos,
            "reload: free counts a dropped source exactly once");
    } else if (action == 2) {
      if (scenario == 12) {
        g_warm_free_probe = [&] {
          const auto finished = grc::rs::adopt_warm_finish();
          const auto reload = grc::rs::adopt_reload_finish();
          check(finished.final && finished.warm_balanced && finished.dropped_unreferenced == 1 &&
                    reload.sources_balanced && reload.dropped_unreferenced == 1,
                "warm free interleaving: finish sees every removed entry classified");
        };
        grc::rs::adopt_resource_freed(rid);
        g_warm_free_probe = {};
      }
      if (warm) grc::rs::adopt_warm_finish();
      const auto final = grc::rs::adopt_reload_finish();
      check(final.final && final.dropped_unreferenced == 1, "reload: finish counts unreferenced source");
      if (scenario >= 12) {
        grc::rs::adopt_resource_freed(rid);
        const auto after = grc::rs::adopt_warm_stats();
        const auto reload = grc::rs::adopt_reload_finish();
        check(after.final && after.warm_balanced && after.dropped_unreferenced == 1 &&
                  after.discarded_freed == 0 && reload.sources_balanced && reload.dropped_freed == 0,
              "warm finish then free: no late warm or reload count");
      }
    } else if (action == 3) grc::rs::adopt_release();
    else {
      g_reload_adopt = false;
      grc::rs::materialize(rid, grc::rs::RefKind::Texture);
      const auto final = grc::rs::adopt_reload_finish();
      check(final.adopted_from_reload == 0 && final.dropped_unreferenced == 1 &&
                final.sources_balanced && grc::rs::adopt_reload_sources_held() == 0,
            "reload: declined adoption drops unused source and preserves conservation");
      check(grc::rs::adopt_resource_stats().textures_reload == 0 &&
                grc::rs::adopt_reload_json(1, 1).find("\"adopted\": true") == std::string::npos,
            "reload: declined adoption does not mark source adopted");
    }
    if (warm && action != 3) {
      const auto final = grc::rs::adopt_warm_finish();
      check(final.warm_balanced && final.held_entries == 0 && final.decode_at_reference == 0,
            "warm reload: every consumed, declined, freed or unreferenced entry balances");
      check(final.served_reload == (action == 0 ? 1u : 0u) &&
                final.discarded_freed == (action == 1 && scenario != 11 ? 1u : 0u) &&
                final.dropped_unreferenced == (action == 2 ? 1u : 0u) &&
                final.discarded_superseded == (action == 4 || scenario == 11 ? 1u : 0u),
            "warm reload: first reference and lifetime paths classify exactly once");
    }
    check(grc::rs::adopt_reload_sources_held() == 0, "reload: every consume/teardown path releases source");
    grc::rs::adopt_reload_finish();
    check(grc::rs::adopt_reload_json(1, 1).find("\"sources_balanced\": true") != std::string::npos,
          "reload: adopted, unreferenced and freed sources balance at finish");
    grc::rs::adopt_resources_end();
    grc::rs::adopt_release();
    w.reset_calls();
  }
  g_reload_scope_allowed = false;
  grc::g_iface = saved;
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
}


void test_warm_free_during_pass() {
  auto &w = fake::world();
  constexpr uint64_t first = 0xcafe1000, second = first + 1;
  grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
  for (const auto rid : {first, second})
    grc::rs::registry_note_texture_create(rid, {16, 16, 5, false, true}, false);
  auto &image = w.make({"Object", "Image"});
  w.singletons["RenderingServer"] = &w.make({"Object", "RenderingServer"});
  std::vector<uint64_t> reads;
  w.overrides["RenderingServer.texture_2d_get"] = [&](fake::Object *, FakeArgs args, void *ret) {
    reads.push_back(fake::arg_u64(args, 0));
    fake::put_object(ret, &image);
  };
  int prepared = 0;
  g_warm_prepare_probe = [&] {
    if (++prepared == 2) grc::rs::adopt_resource_freed(reads.front());
  };
  grc::rs::mirror_enable(false); grc::rs::mirror_enable(true);
  grc::rs::adopt_resources_begin(grc::rs::AdoptFault::None, false);
  const auto queued = grc::rs::adopt_warm_at_arm(grc::rs::warm_now_ns(), "sync");
  g_warm_prepare_probe = {};
  check(queued.discarded_freed == 1, "warm pass: preserves a free during preparation");
  const auto final = grc::rs::adopt_warm_finish();
  check(final.final && final.warm_balanced && final.queued == 2,
        "warm pass: concurrent free and finish balance both queued textures");
  grc::rs::adopt_resources_end(); grc::rs::adopt_release();
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None); w.reset_calls();
}

void test_warm_held_images() {
  auto &w = fake::world();
  constexpr uint64_t rid = 0xcafe3000;
  auto &image = w.make({"Object", "Image"});
  auto &newer = w.make({"Object", "Image"});
  w.singletons["RenderingServer"] = &w.make({"Object", "RenderingServer"});
  for (int scenario = 0; scenario < 5; ++scenario) {
    grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
    grc::rs::registry_note_texture_create(rid, {16, 16, 5, false, true}, false);
    const auto store = [&](void *object) {
      grc::rs::RegistryHoldInput in;
      in.image = grc::rs::RegistryValue(object, [](const void *) {});
      in.width = in.height = 16; in.format = 5; in.bytes = 1024;
      check(grc::rs::registry_note_texture_update(rid, &in) == grc::rs::HoldSkip::None,
            "hold warm: register current image");
    };
    store(&image);
    grc::rs::mirror_enable(false); grc::rs::mirror_enable(true);
    const bool fault = scenario == 1 || scenario == 4;
    grc::rs::adopt_resources_begin(scenario == 4 ? grc::rs::AdoptFault::HoldOffSkipRepublish :
        fault ? grc::rs::AdoptFault::HoldOff : grc::rs::AdoptFault::None, false);
    const int getters = w.count("RenderingServer.texture_2d_get");
    const auto queued = grc::rs::adopt_warm_at_arm(grc::rs::warm_now_ns(), "sync");
    check(queued.from_hold == (fault ? 0u : 1u) && queued.held_at_arm == (fault ? 0u : 1u) &&
              queued.held_bytes_at_arm == (fault ? 0u : 1024u), "hold warm: source and bytes at arm");
    grc::rs::RegistryHoldRef held;
    check(grc::rs::registry_hold(rid, &held) != fault, "hold warm: warm keeps hold except under fault knob");
    check(queued.hold_dropped_fault == (fault ? 1u : 0u) &&
              queued.skipped_by.updated == (fault ? 1u : 0u), "hold warm: fault drops before classification");
    check(w.count("RenderingServer.texture_2d_get") == getters, "hold warm: no dummy getter");
    if (!fault) {
      if (scenario == 2) store(&newer);
      if (scenario == 3) grc::rs::registry_note_texture_update(rid);
      g_reload_adopt = g_hold_adopt = true;
      g_reload_adopt_image = nullptr;
      grc::rs::materialize(rid, grc::rs::RefKind::Texture);
      g_reload_adopt = g_hold_adopt = false;
      if (scenario != 3)
        check(g_reload_adopt_image == (scenario == 2 ? &newer : &image),
              "hold warm: reference uses latest image");
      const auto stats = grc::rs::adopt_warm_stats();
      check(stats.served_hold == (scenario == 0 ? 1u : 0u) &&
                stats.discarded_stale == (scenario == 0 ? 0u : 1u), "hold warm: sequence and missing hold discard stale body");
      check(stats.lazy_from_hold == (scenario == 2 ? 1u : 0u) &&
                stats.decode_at_reference == (scenario == 2 ? 1u : 0u) &&
                stats.lazy_at_reference.updated == 0, "hold warm: lazy hold is eligible at reference");
      if (scenario != 3)
        check(w.count("RenderingServer.texture_2d_get") == getters, "hold warm: served and lazy hold skip getter");
    }
    const auto final = grc::rs::adopt_warm_finish();
    check(final.final && final.warm_balanced, "hold warm: final balances");
    check(final.textures.adopted == (scenario == 0 || scenario == 2 ? 1u : 0u) &&
              final.textures.current == final.textures.adopted && final.textures.creation == 0,
          "hold warm: final snapshots per-arm texture counts");
    grc::rs::adopt_resources_end(); grc::rs::adopt_release(); w.reset_calls();
  }
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
}

void test_warm_census_revalidation() {
  auto &w = fake::world();
  const auto saved = grc::g_iface;
  // One fake packed String: the census reads its text through string_to_utf8_chars.
  static uint64_t packed[] = {1, 1, 0};
  grc::g_iface.string_to_utf8_chars = [](GDExtensionConstStringPtr, char *out, GDExtensionInt n) -> GDExtensionInt {
    const std::string text = "cached.ctex";
    if (out) std::memcpy(out, text.data(), std::min<size_t>(n, text.size()));
    return text.size();
  };
  for (int state = 0; state < 4; ++state) {
    constexpr uint64_t rid = 0xcafe2000;
    grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
    auto &resource = w.make({"Object", "Resource", "CompressedTexture2D"}, rid);
    auto &wrong_class = w.make({"Object", "Resource"}, rid);
    auto &image = w.make({"Object", "Image"});
    w.singletons["ResourceLoader"] = &w.make({"Object", "ResourceLoader"});
    w.singletons["RenderingServer"] = &w.make({"Object", "RenderingServer"});
    bool warming = false;
    w.overrides["ResourceLoader.list_directory"] = [](fake::Object *, FakeArgs, void *ret) {
      const void *data = packed + 2;
      std::memcpy(static_cast<unsigned char *>(ret) + 8, &data, sizeof(data));
    };
    w.overrides["ResourceLoader.has_cached"] = [](fake::Object *, FakeArgs, void *ret) {
      *static_cast<uint8_t *>(ret) = 1;
    };
    w.overrides["ResourceLoader.get_cached_ref"] = [&](fake::Object *, FakeArgs, void *ret) {
      fake::put_object(ret, warming && state == 1 ? nullptr : warming && state == 2 ? &wrong_class : &resource);
    };
    w.overrides["RenderingServer.texture_2d_get"] = [&](fake::Object *, FakeArgs, void *ret) {
      fake::put_object(ret, &image);
    };
    w.overrides["Image.get_width"] = [](fake::Object *, FakeArgs, void *ret) { fake::put_int(ret, 16); };
    w.overrides["Image.get_height"] = w.overrides["Image.get_width"];
    grc::rs::mirror_enable(false); grc::rs::mirror_enable(true);
    grc::rs::adopt_resources_begin(grc::rs::AdoptFault::None, true);
    grc::rs::adopt_reload_at_arm();
    const int before = w.count("RenderingServer.texture_2d_get");
    warming = true;
    if (state == 3) resource.rid = rid + 1;
    const auto stats = grc::rs::adopt_warm_at_arm(grc::rs::warm_now_ns(), "sync");
    check(stats.scanned.census_unregistered == 1, "warm census: scans the unregistered cached RID");
    check(w.count("RenderingServer.texture_2d_get") - before == (state == 0 ? 1 : 0),
          "warm census: getter requires a cached resource of matching class and RID");
    check(stats.from_cache == (state == 0 ? 1u : 0u) && stats.skipped_by.no_image == (state == 0 ? 0u : 1u),
          "warm census: missing or changed resource is counted without warming");
    check(grc::rs::adopt_warm_finish().warm_balanced, "warm census: entries balance after revalidation");
    grc::rs::adopt_resources_end(); grc::rs::adopt_release(); w.reset_calls();
  }
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
  grc::g_iface = saved;
}

// A placeholder discovered after the arm pass must never be published as the original texture.
void test_reload_materialize_guards() {
  auto &w = fake::world();
  const auto run = [&](bool registered, bool known, bool mipmaps, grc::rs::AdoptFault fault) {
    constexpr uint64_t rid = 0xdead1234;
    grc::rs::registry_configure(true, grc::rs::RegistryFault::None);
    if (registered) grc::rs::registry_note_texture_create(rid, {64, 64, 17, false, known}, false);
    auto &image = w.make({"Object", "Image"});
    std::vector<uint64_t> reads;
    fake_rendering_server(&reads);
    w.overrides["RenderingServer.texture_2d_get"] = [&image](fake::Object *, FakeArgs, void *ret) {
      fake::put_object(ret, &image);
    };
    w.overrides["Image.get_width"] = [](fake::Object *, FakeArgs, void *ret) {
      *static_cast<int64_t *>(ret) = 1;
    };
    w.overrides["Image.get_height"] = w.overrides["Image.get_width"];
    w.overrides["Image.get_format"] = [](fake::Object *, FakeArgs, void *ret) {
      *static_cast<int64_t *>(ret) = 0;
    };
    w.overrides["Image.has_mipmaps"] = [mipmaps](fake::Object *, FakeArgs, void *ret) {
      *static_cast<uint8_t *>(ret) = mipmaps;
    };
    grc::rs::mirror_enable(false);
    grc::rs::mirror_enable(true);
    grc::rs::mirror_instance().set_root(kRootViewport, kRootCanvas, kIdentity);
    grc::rs::adopt_resources_begin(fault, true);
    grc::rs::materialize(rid, grc::rs::RefKind::Texture);
    grc::rs::materialize(rid, grc::rs::RefKind::Texture);
    const auto json = grc::rs::adopt_reload_json(1, 1);
    const bool guarded = !mipmaps && fault != grc::rs::AdoptFault::ReloadOff && (!registered || known);
    const auto stats = grc::rs::adopt_resource_stats();
    check(stats.textures_refused == (guarded ? 1u : 0u), "reload guard: refuse once only when provable");
    if (guarded) check(json.find(registered ? "evicted-mid-arm" : "evicted-unverifiable") != std::string::npos,
                       "reload guard: typed refusal evidence");
    grc::rs::adopt_resource_freed(rid);
    if (guarded) check(grc::rs::adopt_resource_stats().refused_live == 0, "reload guard: free forgets refusal");
    grc::rs::adopt_reload_finish();
    grc::rs::adopt_resources_end();
    grc::rs::adopt_release();
    check(grc::rs::adopt_held() == 0, "reload guard: release clears evidence and sources");
    w.reset_calls();
  };
  run(true, true, false, grc::rs::AdoptFault::None);
  run(false, false, false, grc::rs::AdoptFault::None);
  run(true, false, false, grc::rs::AdoptFault::None);
  run(true, true, true, grc::rs::AdoptFault::None);
  run(true, true, false, grc::rs::AdoptFault::ReloadOff);
  run(false, false, false, grc::rs::AdoptFault::ReloadOff);
  grc::rs::registry_configure(false, grc::rs::RegistryFault::None);
}

void test_reentry_admission() {
  fake::install();
  auto &w = fake::world();
  w.reset_calls();
  auto &engine = w.make({"Object", "Engine"});
  auto &tree = w.make({"Object", "SceneTree"});
  auto &root = w.make({"Object", "Node", "Window", "Viewport"});
  auto &node = w.make({"Object", "Node", "CanvasItem", "Control"}, 0x99001);
  w.singletons["Engine"] = &engine;
  w.overrides["Engine.get_main_loop"] = [&tree](fake::Object *, FakeArgs, void *ret) {
    fake::put_object(ret, &tree);
  };
  w.overrides["SceneTree.get_root"] = [&root](fake::Object *, FakeArgs, void *ret) {
    fake::put_object(ret, &root);
  };
  GDExtensionCallableCustomInfo2 callback{};
  static GDExtensionCallableCustomInfo2 *saved = nullptr;
  saved = &callback;
  grc::g_iface.callable_custom_create2 = [](GDExtensionUninitializedTypePtr,
                                           GDExtensionCallableCustomInfo2 *info) {
    *saved = *info;
  };
  std::string error;
  check(grc::rs::node_map_acquire_tag(&error) && callback.call_func != nullptr,
        "reentry: TAG connects its node-added callback");
  if (callback.call_func == nullptr) return;
  alignas(8) unsigned char variant[24]{};
  void *object = &node;
  fake::detail::from_type<void *, GDEXTENSION_VARIANT_TYPE_OBJECT>(variant, &object);
  const GDExtensionConstVariantPtr args[] = {variant};
  auto call = [&] {
    GDExtensionCallError err{};
    callback.call_func(callback.callable_userdata, args, 1, nullptr, &err);
    check(err.error == GDEXTENSION_CALL_OK, "reentry: callback returns OK");
  };
  const int guards = g_guard_entries;
  std::thread worker(call);
  worker.join();
  std::unordered_set<uint64_t> entered;
  grc::rs::tag_take_entered(&entered);
  check(g_guard_entries == guards + 1 && entered.count(node.rid) == 1,
        "reentry: admitted off-main callback guards and queues its RID");
  const int reads = w.count("CanvasItem.get_canvas_item");
  g_test_standby = true;
  std::thread standby(call);
  standby.join();
  g_test_standby = false;
  grc::rs::tag_take_entered(&entered);
  check(entered.empty() && w.count("CanvasItem.get_canvas_item") == reads,
        "reentry: uncounted callback cannot read Objects or enqueue into the next arm");
  grc::g_root_finalized = true;
  call();
  grc::g_root_finalized = false;
  grc::rs::tag_take_entered(&entered);
  check(entered.empty() && w.count("CanvasItem.get_canvas_item") == reads,
        "reentry: shutdown callback cannot read freed scene Objects");
  call();
  grc::rs::node_map_release_tag();
  grc::rs::adopt_release();
  grc::rs::tag_take_entered(&entered);
  check(entered.empty() && grc::rs::adopt_held() == 0,
        "reentry: disarm drops queued entries and the node map");
  saved = nullptr;
}

void test_refusal_records_and_recovery() {
  using namespace grc::rs;
  using json_lite::JValue;
  auto &w = fake::world();
  std::vector<uint64_t> reads;
  fake_rendering_server(&reads);
  w.overrides["RenderingServer.texture_2d_get"] = [](fake::Object *, FakeArgs, void *ret) {
    fake::put_object(ret, nullptr);
  };
  registry_configure(true, RegistryFault::None);
  mirror_enable(false); mirror_enable(true);
  auto &mirror = mirror_instance();
  mirror.set_recover(true, true);
  const auto field = [](const JValue &v, const char *key) -> const JValue & {
    static const JValue missing;
    const auto *p = v.get(key);
    check(p != nullptr, std::string("refusal evidence field: ") + key);
    return p ? *p : missing;
  };
  const auto evidence = [&]() {
    JValue v;
    check(json_lite::Reader(adopt_refusals_json(2, 77)).parse(&v), "refusal evidence parses");
    return v;
  };
  AdoptFault parsed;
  std::string error;
  check(parse_adopt_fault("hold-off-skip-republish", true, &parsed, &error) &&
            parsed == AdoptFault::HoldOffSkipRepublish &&
            std::string(adopt_fault_name(parsed)) == "hold-off-skip-republish", "republication fault parses and names");
  check(!parse_adopt_fault("hold-off-skip-republish", false, &parsed, &error),
        "republication fault requires adoption");
  check(!parse_adopt_fault("invalid", true, &parsed, &error) &&
            error.find("hold-off-skip-republish") != std::string::npos, "invalid fault lists republication knob");
  adopt_resources_begin(AdoptFault::None, true);
  check(!adopt_texture_refused(0x9000), "no texture refusal fast path");
  for (uint64_t i = 0; i < 65; ++i) {
    const auto rid = 0x9000 + i;
    registry_note_texture_create(rid, {i == 0 ? 5 : 64, i == 0 ? 19661 : 64, 11, false, true}, false);
    if (i == 0) {
      RegistryHoldInput in;
      in.width = 5; in.height = 19661; in.format = 11; in.bytes = 1572880; in.frame = 9;
      in.pre = HoldSkip::OverTextureCap;
      in.image = RegistryValue(&w.make({"Object", "Image"}), [](const void *) {});
      check(registry_note_texture_update(rid, &in) == HoldSkip::OverTextureCap,
            "refusal fixture records over-cap skip");
      mirror.material_create(0xa000, 1);
      DecodedParam param; param.type = "rid"; param.tex_rid = rid;
      mirror.material_set_param(0xa000, "src", param, 1);
    }
    materialize(rid, RefKind::Texture);
    materialize(rid, RefKind::Texture);
    check(adopt_texture_refused(rid), "no-image refusal is live");
  }
  auto v = evidence();
  const auto &counts = field(v, "counts");
  check(field(counts, "refused").text == "65" && field(counts, "refused_no_image").text == "65" &&
            field(counts, "records").text == "64" && field(counts, "records_dropped").text == "1",
        "refusals counted once and evidence capped");
  const auto &records = field(v, "records");
  check(records.items.size() == 64, "first 64 refusal records retained");
  if (!records.items.empty()) {
    const auto &r = records.items.front();
    check(field(r, "reason").text == "no-image" && field(r, "frame").text == "1",
          "refusal captures reason and hook frame");
    check(field(field(r, "registry"), "updated").b &&
              field(field(r, "registry"), "width").text == "5" &&
              field(field(r, "last_skip"), "frame").text == "9", "refusal captures registry and newest skip");
    check(field(field(r, "dependents"), "materials").items.size() == 1,
          "write-time evidence queries material dependents");
  }
  check(adopt_held() == 129, "accounting includes 65 live refusals and 64 records");
  const auto &unresolved = field(field(v, "index"), "unresolved");
  check(unresolved.items.size() == 1 && field(unresolved.items.front(), "refused").b,
        "unresolved index marks live refusal");
  adopt_texture_recovered(0x9000, RecoverPath::Replace, 42, {7, 2, 3, false});
  adopt_texture_recovered(0x9000, RecoverPath::Replace, 43, {8, 9, 9, false});
  check(!adopt_texture_refused(0x9000), "replace recovery erases refusal exactly once");
  check(adopt_from_update_begin(), "update adoption counts current texture");
  adopt_texture_recovered(0x9001, RecoverPath::Update, 44, {8, 1, 1, false});
  adopt_texture_recovered(0xffff, RecoverPath::Replace, 45, {});
  auto stats = adopt_resource_stats();
  check(stats.textures == 2 && stats.textures_current == 2 && stats.from_update == 1 &&
            stats.textures_refused == 65 && stats.refused_no_image == 65 && stats.refused_live == 63,
        "recovery preserves historical refusal counts and avoids double adoption");
  v = evidence();
  const auto &recovered = field(field(v, "counts"), "recovered");
  check(field(recovered, "total").text == "2" && field(recovered, "replace").text == "1" &&
            field(recovered, "update").text == "1", "recovery totals split by write path");
  const auto &recovery_records = field(v, "records").items;
  const JValue missing_record;
  const auto &r = field(recovery_records.empty() ? missing_record : recovery_records.front(), "recovered");
  check(field(r, "path").text == "replace" && field(r, "frame").text == "42" &&
            field(r, "published_id").text == "7" && field(r, "materials").text == "2" &&
            field(r, "params").text == "3", "first recovery records published identity and counts");
  check(!field(field(field(v, "index"), "unresolved").items.front(), "refused").b,
        "unresolved evidence distinguishes recovered texture from live refusal");
  check(adopt_warm_finish().textures.recovered == 2, "warm finish includes recovered total");
  for (uint64_t i = 2; i < 65; ++i) adopt_resource_freed(0x9000 + i);
  check(!adopt_texture_refused(0x9002) && adopt_resource_stats().refused_live == 0 && adopt_held() == 64,
        "free drains live texture refusals but preserves records");
  adopt_resources_end();
  check(!adopt_texture_refused(0x9000), "inactive texture refusal query is false");
  adopt_release();
  check(adopt_held() == 0, "release drops all refusal records");
  adopt_resources_begin(AdoptFault::None, true);
  v = evidence();
  check(field(field(v, "counts"), "records").text == "0" &&
            field(field(v, "counts"), "records_dropped").text == "0" &&
            field(field(field(v, "counts"), "recovered"), "total").text == "0", "new arm resets refusal evidence");
  materialize(0xb001, RefKind::Texture);
  registry_note_create(0xb002, RegistryKind::CanvasTexture);
  materialize(0xb002, RefKind::Texture);
  v = evidence();
  const auto &extra = field(v, "records").items;
  check(extra.size() == 2, "unregistered and canvas-empty refusals both recorded");
  if (extra.size() == 2) {
    check(field(extra[0], "registry").kind == JValue::Null &&
              field(extra[0], "reason").text == "no-image" &&
              field(extra[0], "last_skip").kind == JValue::Null,
          "unregistered refusal has no registry or skip facts");
    check(field(extra[1], "reason").text == "canvas-empty" &&
              field(extra[1], "registry").kind == JValue::Null,
          "canvas refusal captures reason without 2D registry facts");
  }
  materialize(0xb000, RefKind::Mesh);
  check(!adopt_texture_refused(0xb000), "mesh refusal is never a texture refusal");
  adopt_resources_end(); adopt_release();
  registry_configure(false, RegistryFault::None);
  w.reset_calls();
}

}  // namespace

int main() {
  test_born_equals_adopted();
  test_sabotages();
  test_residue_and_strict();
  test_caps();
  test_seam_without_engine();
  test_resources_born_equals_adopted();
  test_resources_refinement();
  test_resources_log();
  test_adopt_fault_parse();
  test_materials_born_equals_adopted();
  test_material_scans();
  test_ppm_key_bits();
  // From here the fake engine is installed (process-wide): the engine-free tests above run first.
  test_reentry_admission();
  test_fake_binds();
  test_multimesh_from_registry();
  test_canvas_texture_channels_not_reread();
  test_canvas_texture_registry_gating();
  test_refused_ppm_not_retried();
  test_particles_from_registry();
  test_reload_materialize_guards();
  test_reload_sources();
  test_htr_restore();
  test_evict_duplicate_rid();
  test_warm_free_during_pass();
  test_warm_census_revalidation();
  test_warm_held_images();
  test_refusal_records_and_recovery();
  std::printf("rs_adopt_test: %d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
