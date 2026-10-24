// G8a: the engine-free half of the arm-time adoption pass (src/rs_adopt.*, gate8-design.md D3-D5,
// D13). Each scene is driven twice: once as a capture armed at birth sees it (the hooks' calls,
// in the order CanvasItem / CanvasLayer issue them on entering the tree) and once as the
// adoption walk's AdoptPlan; the two mirrors' snapshots must agree on every field but `origin`.
// Also: the three walk sabotages, the strict/skip handling of a canvas the plan leaves out, the
// mirror's configurable caps, and the seam's refusal without an engine.
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "hooks.h"
#include "rs_adopt.h"
#include "rs_mirror.h"
#include "rs_resource_log.h"

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
  plan.items.push_back(world);
  AdoptedItem box = item(r.box, r.world, false, 0);
  box.self_modulate = kHalf;
  box.z_index = 1;
  plan.items.push_back(box);
  AdoptedItem behind = item(r.behind, r.world, false, 1);
  behind.behind = true;
  plan.items.push_back(behind);
  plan.items.push_back(item(r.top, kRootCanvas, true, 0));
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
            stats.top_level == 4 && stats.canvas_modulates == 1,
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

// rs_adopt.cpp calls the hooks' copy path through these; the engine side never runs here.
namespace grc {
bool hooks_adopt_texture(uint64_t, void *, rs2::AdoptedContent, const char *, bool *) {
  return false;
}
bool hooks_adopt_mesh(uint64_t, const std::vector<rs::AdoptSurface> &, const float[6]) {
  return false;
}
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
  // Lazy adoption is off until a stream begins it; every entry point is then a no-op.
  check(!grc::rs::adopt_resources_active(), "lazy: inactive by default");
  grc::rs::adopt_texture_ref(0x50);
  grc::rs::adopt_mesh_ref(0x60);
  check(!grc::rs::adopt_from_update_begin(), "lazy: no update adoption while inactive");
  check(grc::rs::adopt_resource_stats().textures == 0, "lazy: nothing counted");
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
  std::printf("rs_adopt_test: %d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
