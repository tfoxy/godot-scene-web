// Unit test for the retained canvas mirror (src/rs_mirror.h).
//
// Drives the mirror through its public API exactly as the hooks do, with plain
// uint64 RIDs and no engine, and checks the snapshots against
// protocol/gate0-design.md "Q1" and "Q3", render-stream-0.md "Transaction",
// and (gate 1, G1b2) render-stream-1.md "Invariant 9" / "Unsupported reasons"
// and gate1-design.md "Q1", "Q4" and "G1b2" (omit-op, mutation epoch), and
// (gate 2, G2b2) gate2-design.md Q3 "Texture mirror" with render-stream-2.md
// "Texture" and "Item-level unsupported entries", and (gate 3, G3a)
// gate3-design.md Q3 "Mirror fix": canvas_item_clear resets clip, and (gate 4, G4e2)
// gate4-design.md Q3 "MSDF tap" and "perturb-glyph", and (gate 5, G5d) gate5-design.md Q3b/Q3c:
// the render-stream/4 immediate geometry taps, add_set_transform, add_clip_ignore (a typed
// refusal from G3d until G5d), D11's RID() ambiguity and perturb-vertex, (G5e) the mesh
// table: ids, versions, whole-surface payloads, tombstones, add_mesh, unsupported/unknown meshes,
// omit-op and perturb-vertex on payloads, and protocol/unknown-item-skip.md: the opt-in Skip
// policy's exclusion rules (unknown target, unknown parent, reparent into/out of a withheld
// subtree with re-keying, free of an unknown RID) and patch/full equivalence over them.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs_mesh_payload.h"
#include "rs_mirror.h"
#include "rs_sha256.h"
#include "rs_shader_payload.h"
#include "rs_texture_payload.h"

namespace {

using grc::rs2::Color4;
using grc::rs2::CommandKind;
using grc::rs2::FailureReason;
using grc::rs::Mirror;
using grc::rs2::ParentKind;
using grc::rs2::Rect4;
using grc::rs2::Snapshot;
using grc::rs2::UnsupportedReason;
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
constexpr Xform kRootXform = {1, 0, 0, 1, 0, 0};
constexpr Color4 kRed = {1, 0, 0, 1};
constexpr Color4 kGreen = {0, 1, 0, 1};
constexpr Rect4 kRect = {0, 0, 96, 64};

// A mirror with the root bound, as after a successful arm-time root query.
void bind_root(Mirror *mirror) {
  mirror->reset();
  mirror->set_root(kRootViewport, kRootCanvas, kRootXform);
}

const grc::rs2::ItemState *item(const Snapshot &s, uint32_t id) {
  for (const auto &it : s.items) {
    if (it.id == id) return &it;
  }
  return nullptr;
}

const grc::rs2::CanvasState *canvas(const Snapshot &s, uint32_t id) {
  for (const auto &c : s.canvases) {
    if (c.id == id) return &c;
  }
  return nullptr;
}

bool has_failure(const Snapshot &s, FailureReason reason) {
  for (const auto &f : s.failures) {
    if (f.reason == reason) return true;
  }
  return false;
}

std::vector<uint32_t> ids(const std::vector<uint32_t> &list) { return list; }

// The item-level entries of a snapshot, as (item, op, reason) in order.
struct Entry {
  uint32_t item;
  std::string op;
  UnsupportedReason reason;
  bool operator==(const Entry &o) const {
    return item == o.item && op == o.op && reason == o.reason;
  }
};

std::vector<Entry> item_entries(const Snapshot &s) {
  std::vector<Entry> out;
  for (const auto &u : s.unsupported) {
    if (u.has_item) out.push_back({u.item, u.op, u.reason});
  }
  return out;
}

std::vector<Entry> ties(const Snapshot &s) {
  std::vector<Entry> out;
  for (const auto &u : s.unsupported) {
    if (u.reason == UnsupportedReason::DrawIndexTie) out.push_back({u.item, u.op, u.reason});
  }
  return out;
}

Entry tie(uint32_t id) { return {id, "canvas_item_set_draw_index", UnsupportedReason::DrawIndexTie}; }

// G55d (render-stream-5.md "Derived item-level entries"): a material RID the material table does
// not know is item-level unknown-material (never /4's unsupported-state).
bool has_material_entry(const Snapshot &s, uint32_t id) {
  for (const auto &u : s.unsupported) {
    if (u.has_item && u.item == id && u.reason == UnsupportedReason::UnknownMaterial &&
        u.op == "canvas_item_set_material")
      return true;
  }
  return false;
}

// gate5-design.md D2, calibrator 7: canvas_item_attach_skeleton with a non-null skeleton, the
// same unsupported-state idea as a non-null material, under its own op name.
bool has_skeleton_entry(const Snapshot &s, uint32_t id) {
  for (const auto &u : s.unsupported) {
    if (u.has_item && u.item == id && u.reason == UnsupportedReason::UnsupportedState &&
        u.op == "canvas_item_attach_skeleton")
      return true;
  }
  return false;
}

void test_fresh_session() {
  Mirror m;
  bind_root(&m);
  const Snapshot s = m.snapshot(7, 9).state;
  check(s.seq == 7 && s.frame == 9, "seq and frame are copied");
  check(s.failures.empty(), "a bound root has no failure");
  check(s.status() == grc::rs2::TransactionStatus::Ok, "status ok");
  check(s.canvases.size() == 1, "only the root canvas");
  const auto *root = canvas(s, 1);
  check(root != nullptr && root->origin == grc::rs2::Origin::RootQuery &&
            root->role == grc::rs2::CanvasRole::Root && root->attached && root->items.empty(),
        "canvas 1 is the root: root-query, role root, attached, no items");
  check(s.items.empty() && s.unsupported.empty(), "no items, no unsupported");
}

void test_ids_and_recycled_rid() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.canvas_item_create(101, 1);
  m.canvas_create(200, 1);
  Snapshot s = m.snapshot(1, 1).state;
  check(item(s, 1) != nullptr && item(s, 2) != nullptr, "items get ids 1, 2");
  check(canvas(s, 2) != nullptr && canvas(s, 2)->origin == grc::rs2::Origin::Created &&
            canvas(s, 2)->role == grc::rs2::CanvasRole::None && !canvas(s, 2)->attached,
        "a created canvas gets id 2 (after the root), role none, not attached");
  check(item(s, 1)->visibility_layer == 0xFFFFFFFFu && item(s, 1)->visible &&
            item(s, 1)->modulate == grc::rs2::kWhite && item(s, 1)->content_version == 0 &&
            item(s, 1)->parent.kind == ParentKind::None,
        "a new item has the RenderingServer defaults");

  // Free item 1, then let the engine hand the same RID value out again: it is
  // a new object and must get a new id, never 1 again.
  m.free_rid(100, 2);
  m.canvas_item_create(100, 2);
  s = m.snapshot(2, 2).state;
  check(item(s, 1) == nullptr, "freed item 1 is gone");
  check(item(s, 3) != nullptr, "the recycled RID gets id 3");
  check(s.items.size() == 2 && s.items[0].id == 2 && s.items[1].id == 3, "items sorted by id");

  m.free_rid(200, 3);
  m.canvas_create(200, 3);
  s = m.snapshot(3, 3).state;
  check(canvas(s, 2) == nullptr && canvas(s, 3) != nullptr, "a recycled canvas RID gets id 3");
  check(s.failures.empty(), "no failure from any of that");
}

void test_append_on_same_parent() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);  // 1
  m.canvas_item_create(101, 1);  // 2
  m.canvas_item_create(102, 1);  // 3
  m.set_parent(100, kRootCanvas, 1);
  m.set_parent(101, kRootCanvas, 1);
  m.set_parent(102, 100, 1);  // item 3 under item 1
  Snapshot s = m.snapshot(1, 1).state;
  check(canvas(s, 1)->items == ids({1, 2}), "root canvas lists 1, 2 in append order");
  check(item(s, 1)->children == ids({3}), "item 1 lists child 3");
  check(item(s, 3)->parent.kind == ParentKind::Item && item(s, 3)->parent.id == 1,
        "item 3's parent is item 1");
  check(item(s, 1)->parent.kind == ParentKind::Canvas && item(s, 1)->parent.id == 1,
        "item 1's parent is canvas 1");

  // renderer_canvas_cull.cpp:569-598: setting the same parent again removes
  // and re-appends.
  m.set_parent(100, kRootCanvas, 2);
  s = m.snapshot(2, 2).state;
  check(canvas(s, 1)->items == ids({2, 1}), "re-parenting to the same canvas appends at the end");

  // Move item 3 from item 1 to the root canvas, then detach item 2.
  m.set_parent(102, kRootCanvas, 3);
  m.set_parent(101, 0, 3);
  s = m.snapshot(3, 3).state;
  check(item(s, 1)->children.empty(), "item 3 left item 1's list");
  check(canvas(s, 1)->items == ids({1, 3}), "root lists 1, 3; detached item 2 is in no list");
  check(item(s, 2)->parent.kind == ParentKind::None, "a null parent detaches");
}

void test_free_canvas_and_item() {
  Mirror m;
  bind_root(&m);
  m.canvas_create(200, 1);       // canvas 2
  m.canvas_item_create(100, 1);  // 1
  m.canvas_item_create(101, 1);  // 2
  m.canvas_item_create(102, 1);  // 3
  m.canvas_item_create(103, 1);  // 4
  m.set_parent(100, 200, 1);
  m.set_parent(101, 200, 1);
  m.set_parent(102, kRootCanvas, 1);
  m.set_parent(103, 102, 1);

  // Free a canvas: its items lose their parent (renderer_canvas_cull.cpp:2566).
  m.free_rid(200, 2);
  Snapshot s = m.snapshot(1, 2).state;
  check(canvas(s, 2) == nullptr, "freed canvas 2 is gone");
  check(item(s, 1)->parent.kind == ParentKind::None && item(s, 2)->parent.kind == ParentKind::None,
        "the freed canvas's items are detached");

  // Free an item: it leaves its parent's list and its children are orphaned
  // (:2585-2600).
  m.free_rid(102, 3);
  s = m.snapshot(2, 3).state;
  check(item(s, 3) == nullptr, "freed item 3 is gone");
  check(canvas(s, 1)->items.empty(), "freed item 3 left the root canvas's list");
  check(item(s, 4)->parent.kind == ParentKind::None, "freed item 3's child is detached");

  // A freed RID is unknown afterwards.
  m.set_visible(102, false, 4);
  s = m.snapshot(3, 4).state;
  check(has_failure(s, FailureReason::PreExistingObject), "a call on a freed item's RID fails");

  // free() of an unknown RID (a texture, a mesh) is counted and ignored.
  Mirror n;
  bind_root(&n);
  n.free_rid(999, 1);
  check(n.stats().free_unknown == 1, "free of an unknown RID is counted");
  check(n.snapshot(1, 1).state.failures.empty(), "free of an unknown RID is not a failure");

  // Freeing the root canvas keeps canvas 1 in every snapshot.
  n.canvas_item_create(100, 1);
  n.set_parent(100, kRootCanvas, 1);
  n.free_rid(kRootCanvas, 2);
  s = n.snapshot(2, 2).state;
  check(canvas(s, 1) != nullptr && canvas(s, 1)->items.empty(),
        "a freed root canvas stays as canvas 1 with no items");
  check(item(s, 1)->parent.kind == ParentKind::None, "its item is detached");
}

void test_content_versions() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.clear(100, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  Snapshot s = m.snapshot(1, 1).state;
  const auto *it = item(s, 1);
  check(it->content_version == 2, "clear + add_rect bump content_version to 2");
  check(it->commands.size() == 1 && it->commands[0].kind == CommandKind::AddRect &&
            it->commands[0].rect == kRect && it->commands[0].color == kRed &&
            !it->commands[0].antialiased,
        "add_rect is recorded with its rect, colour and antialiased flag");

  // A transform-only change does not touch content_version.
  m.set_transform(100, {1, 0, 0, 1, 288, 96}, 2);
  s = m.snapshot(2, 2).state;
  check(item(s, 1)->content_version == 2, "set_transform leaves content_version alone");
  check(item(s, 1)->xform[4] == 288.0f && item(s, 1)->xform[5] == 96.0f, "transform stored");

  m.clear(100, 3);
  m.add_rect(100, kRect, kGreen, true, 3);
  s = m.snapshot(3, 3).state;
  check(item(s, 1)->content_version == 4, "a redraw bumps content_version twice more");
  check(item(s, 1)->commands.size() == 1 && item(s, 1)->commands[0].color == kGreen &&
            item(s, 1)->commands[0].antialiased,
        "clear empties the commands before the new add_rect");
}

void test_setters() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_modulate(100, {0.5f, 0.5f, 0.5f, 1}, 1);
  m.set_self_modulate(100, kRed, 1);
  m.set_visible(100, false, 1);
  m.set_clip(100, true, 1);
  m.set_custom_rect(100, true, {1, 2, 3, 4}, 1);
  m.set_visibility_layer(100, 1, 1);
  m.set_z_index(100, -3, 1);
  m.set_draw_index(100, 7, 1);
  m.set_z_relative(100, false, 1);
  m.set_behind(100, true, 1);
  const Snapshot s = m.snapshot(1, 1).state;
  const auto *it = item(s, 1);
  check(it->modulate == Color4{0.5f, 0.5f, 0.5f, 1}, "modulate stored");
  check(it->self_modulate == kRed, "self_modulate stored");
  check(!it->visible && it->clip, "visible and clip stored");
  check(it->custom_rect && it->custom_rect_rect == Rect4{1, 2, 3, 4}, "custom rect stored");
  check(it->visibility_layer == 1 && it->z_index == -3 && it->draw_index == 7,
        "visibility_layer, z_index and draw_index stored");
  check(!it->z_relative && it->behind, "z_relative and behind stored");
  check(s.failures.empty(), "setters on a known item do not fail");
}

void test_unsupported_and_material() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);  // 1
  m.canvas_item_create(101, 1);  // 2
  m.add_rect(101, kRect, kRed, false, 1);
  m.add_unsupported(101, "canvas_item_add_line", 1);
  m.add_unsupported(101, "canvas_item_add_circle", 1);
  m.add_unsupported(101, "canvas_item_add_line", 1);
  m.set_material(101, 0x77, 1);
  m.add_unsupported(100, "canvas_item_add_polygon", 1);
  Snapshot s = m.snapshot(1, 1).state;

  const auto *two = item(s, 2);
  check(two->commands.size() == 4 && two->commands[1].kind == CommandKind::Unsupported &&
            two->commands[1].name == "canvas_item_add_line" &&
            two->commands[2].name == "canvas_item_add_circle",
        "unsupported commands keep their place in command order");
  check(two->content_version == 4, "each add_* bumps content_version (material does not)");
  check(has_material_entry(s, 2), "an unknown material RID gives an unknown-material entry");
  check(!item(s, 2)->has_material, "an unknown material RID is material: null on the wire");

  // Item order, then op order (byte order); one entry per distinct name.
  check(s.unsupported.size() == 4, "4 de-duplicated unsupported entries");
  if (s.unsupported.size() == 4) {
    const auto &u = s.unsupported;
    check(u[0].has_item && u[0].item == 1 && u[0].op == "canvas_item_add_polygon" &&
              u[0].reason == UnsupportedReason::UnsupportedOp,
          "item 1 first");
    check(u[1].item == 2 && u[1].op == "canvas_item_add_circle", "item 2: add_circle");
    check(u[2].item == 2 && u[2].op == "canvas_item_add_line", "item 2: add_line once");
    check(u[3].item == 2 && u[3].op == "canvas_item_set_material" &&
              u[3].reason == UnsupportedReason::UnknownMaterial,
          "item 2: set_material, unknown-material, sorted among the ops");
  }
  check(s.failures.empty(), "unsupported is not a capture failure");

  m.set_material(101, 0, 2);
  m.clear(101, 2);
  s = m.snapshot(2, 2).state;
  check(!has_material_entry(s, 2), "a null material clears the unknown-material entry");
  check(s.unsupported.size() == 1 && s.unsupported[0].item == 1,
        "only item 1's add_polygon is left after clear + null material");
}

void test_viewport_hooks() {
  Mirror m;
  bind_root(&m);
  m.canvas_create(200, 1);  // canvas 2
  // The root viewport with the root canvas: attached already, xform stored.
  m.viewport_attach_canvas(kRootViewport, kRootCanvas, 1);
  m.viewport_set_canvas_transform(kRootViewport, kRootCanvas, {2, 0, 0, 2, 5, 6}, 1);
  Snapshot s = m.snapshot(1, 1).state;
  check(s.unsupported.empty() && s.failures.empty(), "root attach and transform are supported");
  check(canvas(s, 1)->xform == Xform{2, 0, 0, 2, 5, 6}, "root canvas transform stored");

  // A second canvas on the root viewport (G6b, render-stream/6): attached and supported, no
  // extra-canvas; at the attach default (0,0) it ties with the root canvas until its stacking
  // lands.
  m.viewport_attach_canvas(kRootViewport, 200, 2);
  m.viewport_set_canvas_transform(kRootViewport, 200, {1, 0, 0, 1, 3, 4}, 2);
  s = m.snapshot(2, 2).state;
  check(s.unsupported.size() == 1 && !s.unsupported[0].has_item &&
            s.unsupported[0].op == "viewport_set_canvas_stacking" &&
            s.unsupported[0].reason == UnsupportedReason::CanvasStackingTie,
        "an extra canvas at the attach default (0,0) ties with the root: canvas-stacking-tie");
  m.viewport_set_canvas_stacking(kRootViewport, 200, 1, 0, 2);
  // A non-root viewport: non-root-viewport for both ops, mirror unchanged.
  m.viewport_attach_canvas(0x9999, 200, 2);
  m.viewport_set_canvas_transform(0x9999, kRootCanvas, {9, 9, 9, 9, 9, 9}, 2);
  m.viewport_attach_canvas(0x9999, 200, 2);  // de-duplicated
  s = m.snapshot(2, 2).state;
  check(canvas(s, 2)->attached && canvas(s, 2)->xform == Xform{1, 0, 0, 1, 3, 4} &&
            canvas(s, 2)->layer == 1 && canvas(s, 2)->sublayer == 0,
        "the extra canvas is attached, its transform and stacking stored");
  check(canvas(s, 1)->xform == Xform{2, 0, 0, 2, 5, 6},
        "a non-root viewport's transform does not touch the root canvas");
  check(s.unsupported.size() == 2, "2 session-level entries (the tie is gone)");
  if (s.unsupported.size() == 2) {
    check(s.unsupported[0].op == "viewport_attach_canvas" &&
              s.unsupported[0].reason == UnsupportedReason::NonRootViewport,
          "first observed: attach on a non-root viewport");
    check(s.unsupported[1].op == "viewport_set_canvas_transform" &&
              s.unsupported[1].reason == UnsupportedReason::NonRootViewport,
          "then transform on a non-root viewport");
  }
  check(s.failures.empty(), "unsupported viewport use is not a failure");

  // Session-level entries come before item-level ones and stay after the
  // extra canvas is freed.
  m.canvas_item_create(100, 3);
  m.add_unsupported(100, "canvas_item_add_mesh", 3);
  m.free_rid(200, 3);
  s = m.snapshot(3, 3).state;
  check(s.unsupported.size() == 3 && !s.unsupported[1].has_item && s.unsupported[2].has_item,
        "session-level entries first, sticky, then item-level");

  // An unknown canvas on the root viewport is pre-existing-object.
  Mirror n;
  bind_root(&n);
  n.viewport_set_canvas_transform(kRootViewport, 0x5555, kRootXform, 4);
  s = n.snapshot(1, 4).state;
  check(has_failure(s, FailureReason::PreExistingObject) &&
            s.failures[0].detail == "rid=21845 op=viewport_set_canvas_transform frame=4",
        "unknown canvas on the root viewport -> pre-existing-object with rid/op/frame detail");
}

void test_unknown_rid() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  // A Node2D constructed before arming enters the tree: set_parent names an
  // item the mirror never saw.
  m.set_parent(0xABC, kRootCanvas, 1);
  m.set_transform(0xDEF, kRootXform, 2);  // a second unknown: not recorded again
  m.set_parent(100, 0x777, 3);            // unknown parent: not recorded again either
  Snapshot s = m.snapshot(1, 3).state;
  check(s.status() == grc::rs2::TransactionStatus::CaptureFailure, "status capture-failure");
  check(s.failures.size() == 1 && s.failures[0].reason == FailureReason::PreExistingObject &&
            s.failures[0].detail == "rid=2748 op=canvas_item_set_parent frame=1",
        "pre-existing-object names the first event only");
  check(item(s, 1)->parent.kind == ParentKind::None, "a call with an unknown parent changes nothing");

  // Sticky: still there after more good calls.
  m.set_visible(100, false, 4);
  s = m.snapshot(2, 4).state;
  check(s.failures.size() == 1 && !item(s, 1)->visible, "sticky, and good calls still apply");

  // An unknown parent alone is also pre-existing-object.
  Mirror n;
  bind_root(&n);
  n.canvas_item_create(100, 1);
  n.set_parent(100, 0x777, 5);
  s = n.snapshot(1, 5).state;
  check(s.failures.size() == 1 && s.failures[0].detail == "rid=1911 op=canvas_item_set_parent frame=5",
        "unknown parent RID -> pre-existing-object");
}

void test_root_query_failure() {
  Mirror m;
  m.reset();
  m.set_root(0, 0, {0, 0, 0, 0, 0, 0});
  m.fail_root_query("Viewport.get_world_2d");
  m.fail_root_query("again");
  m.canvas_item_create(100, 1);
  const Snapshot s = m.snapshot(1, 1).state;
  check(s.failures.size() == 1 && s.failures[0].reason == FailureReason::RootQueryFailed &&
            s.failures[0].detail == "Viewport.get_world_2d",
        "root-query-failed is sticky and keeps the first detail");
  check(canvas(s, 1) != nullptr, "canvas 1 still exists after a failed root query");
  // With no root viewport bound, every viewport is non-root.
  m.viewport_attach_canvas(0, 0, 1);
  check(m.snapshot(2, 1).state.unsupported.size() == 1, "zero viewport RID never matches the root");
}

void test_omit_update() {
  Mirror m;
  bind_root(&m);
  m.set_drop_frame(21);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  const Snapshot before = m.snapshot(1, 20).state;

  // Frame 21: every mutation is dropped, identity bookkeeping is kept.
  m.clear(100, 21);
  m.add_rect(100, kRect, kGreen, false, 21);
  m.set_transform(100, {1, 0, 0, 1, 50, 50}, 21);
  m.set_modulate(100, kRed, 21);
  m.set_self_modulate(100, kRed, 21);
  m.set_visible(100, false, 21);
  m.set_clip(100, true, 21);
  m.set_custom_rect(100, true, kRect, 21);
  m.set_visibility_layer(100, 2, 21);
  m.set_z_index(100, 5, 21);
  m.set_draw_index(100, 9, 21);
  m.set_material(100, 0x77, 21);
  m.add_unsupported(100, "canvas_item_add_circle", 21);
  m.set_parent(100, 0, 21);
  m.viewport_set_canvas_transform(kRootViewport, kRootCanvas, {3, 0, 0, 3, 0, 0}, 21);
  m.canvas_item_create(101, 21);  // kept
  m.canvas_item_create(102, 21);  // kept, then freed in the same frame
  m.free_rid(102, 21);
  // A call naming the frame-21 item later is still known: no pre-existing failure.
  m.set_parent(101, kRootCanvas, 22);
  const Snapshot after = m.snapshot(2, 22).state;

  const auto *a = item(after, 1);
  const auto *b = item(before, 1);
  check(a->content_version == b->content_version && a->commands.size() == 1 &&
            a->commands[0].color == kRed,
        "frame-21 clear/add_rect dropped");
  check(a->xform == b->xform && a->modulate == b->modulate &&
            a->self_modulate == b->self_modulate && a->visible && !a->clip && !a->custom_rect &&
            a->visibility_layer == b->visibility_layer && a->z_index == 0 &&
            a->draw_index == 0 && !has_material_entry(after, 1),
        "frame-21 setters dropped");
  check(a->parent.kind == ParentKind::Canvas, "frame-21 set_parent dropped");
  check(canvas(after, 1)->xform == kRootXform, "frame-21 canvas transform dropped");
  check(item(after, 2) != nullptr && item(after, 3) == nullptr,
        "frame-21 create and free are kept (item 2 lives, item 3 created and freed)");
  check(canvas(after, 1)->items == ids({1, 2}), "the frame-22 parent call on item 2 applies");
  check(after.failures.empty(), "omit-update never becomes a pre-existing-object failure");
  check(m.stats().dropped_omit_update == 15, "15 mutations dropped");

  m.set_drop_frame(0);
  m.set_z_index(100, 5, 21);
  check(item(m.snapshot(3, 23).state, 1)->z_index == 5, "drop frame 0 disables the sabotage");
}

void test_capacity() {
  Mirror m;
  bind_root(&m);
  for (uint64_t i = 0; i < grc::rs2::kMaxLiveItems; ++i) {
    m.canvas_item_create(1000 + i, 1);
  }
  Snapshot s = m.snapshot(1, 1).state;
  check(s.items.size() == grc::rs2::kMaxLiveItems && s.failures.empty(),
        "exactly the cap of live items is fine");
  const uint64_t over = 1000 + grc::rs2::kMaxLiveItems;
  m.canvas_item_create(over, 2);
  m.set_parent(over, kRootCanvas, 2);  // untracked: ignored, not pre-existing
  m.add_rect(over, kRect, kRed, false, 2);
  s = m.snapshot(2, 2).state;
  check(s.items.size() == grc::rs2::kMaxLiveItems, "the item over the cap is not tracked");
  check(s.failures.size() == 1 && s.failures[0].reason == FailureReason::MirrorCapacity,
        "live items over the cap -> mirror-capacity only (no pre-existing-object)");
  check(m.stats().ignored_untracked == 2, "calls on the untracked item are counted");
  m.free_rid(over, 3);
  check(m.stats().free_unknown == 0, "freeing the untracked item is not an unknown free");

  // Freeing one makes room again, but the failure is sticky.
  m.free_rid(1000, 4);
  m.canvas_item_create(9, 4);
  s = m.snapshot(3, 4).state;
  check(s.items.size() == grc::rs2::kMaxLiveItems && s.items.back().id ==
                                                         grc::rs2::kMaxLiveItems + 1,
        "after a free there is room; the new item gets the next id");
  check(s.failures.size() == 1, "mirror-capacity is sticky");

  Mirror n;
  bind_root(&n);
  n.canvas_item_create(100, 1);
  for (size_t i = 0; i < grc::rs2::kMaxCommandsPerItem; ++i) {
    n.add_rect(100, kRect, kRed, false, 1);
  }
  s = n.snapshot(1, 1).state;
  check(s.failures.empty() && item(s, 1)->commands.size() == grc::rs2::kMaxCommandsPerItem,
        "exactly the command cap is fine");
  n.add_rect(100, kRect, kGreen, false, 2);
  n.add_unsupported(100, "canvas_item_add_line", 2);
  s = n.snapshot(2, 2).state;
  check(item(s, 1)->commands.size() == grc::rs2::kMaxCommandsPerItem,
        "commands over the cap are dropped");
  check(item(s, 1)->content_version == grc::rs2::kMaxCommandsPerItem,
        "dropped commands do not bump content_version");
  check(s.failures.size() == 1 && s.failures[0].reason == FailureReason::MirrorCapacity &&
            s.failures[0].detail == "commands > 1024 item=1 frame=2",
        "commands over the cap -> mirror-capacity");
}

void test_process_wide_gate() {
  using namespace grc::rs;
  check(!mirror_enabled(), "the process-wide mirror starts disabled");
  mirror_enable(true);
  check(mirror_enabled(), "enabled");
  mirror_set_root(kRootViewport, kRootCanvas, kRootXform);
  mirror_instance().canvas_item_create(100, 1);
  mirror_set_drop_frame(5);
  mirror_instance().set_z_index(100, 3, 5);
  Snapshot s = mirror_snapshot(1, 1).state;
  check(s.items.size() == 1 && s.items[0].z_index == 0, "mirror_set_drop_frame applies");
  mirror_enable(true);  // already enabled: no reset
  check(mirror_snapshot(2, 2).state.items.size() == 1, "re-enabling while enabled keeps the state");
  mirror_enable(false);
  check(mirror_snapshot(3, 3).state.items.size() == 1, "disabling keeps the state readable");
  mirror_enable(true);
  s = mirror_snapshot(4, 4).state;
  check(s.items.empty() && s.canvases.size() == 1, "enabling from disabled starts a new session");
  mirror_fail_root_query("Engine.get_main_loop");
  check(mirror_snapshot(5, 5).state.failures.size() == 1, "mirror_fail_root_query");
  check(mirror_stats().live_canvases == 1, "mirror_stats");
  mirror_enable(false);
}

// HC4a (host-cost-design.md D1): the persistent item and canvas tables. A static snapshot shares
// every chunk with the last one and visits no item; a same-value setter republishes nothing; a
// real change replaces one entry of one chunk; ties, item-level entries and removals follow the
// changes; the shadow oracle agrees, and catches both sabotages.
std::uint64_t g_expected_shadow_mismatches = 0;

void build_hc4a_scene(Mirror *m) {
  bind_root(m);
  for (uint64_t i = 0; i < 200; ++i) {
    const uint64_t rid = 0x5000 + i;
    m->canvas_item_create(rid, 1);
    m->set_parent(rid, kRootCanvas, 1);
    if (i % 2 == 0) {
      m->add_rect(rid, kRect, kRed, false, 1);
    }
    m->set_draw_index(rid, static_cast<int32_t>(i), 1);
  }
}

void test_hc4a_persistent_tables() {
  Mirror m;
  build_hc4a_scene(&m);
  const Snapshot a = m.snapshot(1, 1).state;
  check(a.items.size() == 200 && a.items.chunks().size() == 4, "200 items in 4 chunks of 64 ids");
  check(a.items[63].id == 64 && a.items[64].id == 65 && a.items.back().id == 200,
        "indexing crosses chunks in id order");
  const auto visited0 = m.stats().hc_items_visited;
  const Snapshot b = m.snapshot(2, 2).state;
  check(b.items.shares(a.items) && b.canvases.shares(a.canvases),
        "a static snapshot shares every item and canvas chunk");
  check(m.stats().hc_items_visited == visited0, "a static snapshot visits no item");
  const grc::rs2::Transaction still = grc::rs2::make_patch(a, b);
  check(still.items.empty() && still.removed_items.empty() && still.canvases.empty(),
        "a static patch is empty");

  // A same-value setter: visited, not republished.
  const auto republished0 = m.stats().hc_items_republished;
  m.set_transform(0x5007, kRootXform, 3);
  const Snapshot c = m.snapshot(3, 3).state;
  check(m.stats().hc_items_republished == republished0 && c.items.shares(b.items),
        "a same-value setter republishes nothing");

  // A real change: one entry of one chunk.
  Xform moved = kRootXform;
  moved[4] = 5.0f;
  m.set_transform(0x5000 + 70, moved, 4);  // id 71: chunk 1
  const Snapshot d = m.snapshot(4, 4).state;
  check(d.items.chunks()[0] == c.items.chunks()[0] && d.items.chunks()[2] == c.items.chunks()[2] &&
            d.items.chunks()[1] != c.items.chunks()[1],
        "a change replaces its own chunk only");
  check(d.items.chunks()[1]->entries[0] == c.items.chunks()[1]->entries[0],
        "the other entries of a changed chunk stay shared");
  const grc::rs2::Transaction one = grc::rs2::make_patch(c, d);
  check(one.items.size() == 1 && one.items[0].state.id == 71 && one.items[0].commands_null,
        "the patch carries the one moved item");
  check(item(c, 71)->xform[4] == 0.0f, "an earlier snapshot keeps its entry");

  // Ties follow draw-index changes (two drawing items at one index), and leave with them.
  m.set_draw_index(0x5000 + 4, 2, 5);  // id 5 (drawing) joins id 3 (drawing) at index 2
  const Snapshot e = m.snapshot(5, 5).state;
  check(ties(e) == std::vector<Entry>{tie(3)}, "a draw-index tie appears at its smallest id");
  m.set_draw_index(0x5000 + 4, 4, 6);
  const Snapshot f = m.snapshot(6, 6).state;
  check(ties(f).empty(), "and leaves with the change");

  // An item-level entry follows its item; a freed item leaves the table and its chunk.
  m.add_unsupported(0x5000 + 130, "canvas_item_add_lcd_texture_rect_region", 7);
  const Snapshot g = m.snapshot(7, 7).state;
  check(item_entries(g).size() == 1 && item_entries(g)[0].item == 131,
        "an unsupported command's entry appears");
  m.free_rid(0x5000 + 130, 8);
  const Snapshot h = m.snapshot(8, 8).state;
  check(item(h, 131) == nullptr && item_entries(h).empty() && h.items.size() == 199,
        "a freed item leaves the table with its entries");
  const grc::rs2::Transaction gone = grc::rs2::make_patch(g, h);
  check(gone.removed_items == std::vector<uint32_t>({131}) && gone.canvases.size() == 1,
        "the patch removes it and lists the root canvas's new item list");
}

void test_hc4a_shadow_sabotages() {
  // hc-skip-dirty: every 16th mark lost, so some item's change never reaches its entry.
  {
    Mirror m;
    m.set_hc_shadow(true, grc::rs2::ProtocolVersion::V8);
    m.set_hc_sabotage(true, false);
    build_hc4a_scene(&m);
    Xform moved = kRootXform;
    for (uint64_t frame = 2; frame < 6; ++frame) {
      moved[4] = static_cast<float>(frame);
      for (uint64_t i = 0; i < 40; ++i) {
        m.set_transform(0x5000 + i, moved, frame);
      }
      m.snapshot(frame, frame);
    }
    check(m.stats().hc_dirty_marks_dropped > 0, "hc-skip-dirty drops marks");
    check(m.stats().hc_shadow_mismatches > 0 &&
              m.hc_shadow_failure().rfind("items id ", 0) == 0,
          "the shadow oracle catches hc-skip-dirty (" + m.hc_shadow_failure() + ")");
    g_expected_shadow_mismatches += m.stats().hc_shadow_mismatches;
  }
  // hc-stale-derived: one item keeps its stale item-level entries.
  {
    Mirror m;
    m.set_hc_shadow(true, grc::rs2::ProtocolVersion::V8);
    m.set_hc_sabotage(false, true);
    build_hc4a_scene(&m);
    m.snapshot(1, 1);
    m.add_unsupported(0x5000 + 9, "canvas_item_add_lcd_texture_rect_region", 2);
    const Snapshot s = m.snapshot(2, 2).state;
    check(item_entries(s).empty(), "hc-stale-derived keeps the item's stale (empty) entries");
    check(m.hc_shadow_failure().rfind("unsupported id 10", 0) == 0,
          "the shadow oracle catches hc-stale-derived (" + m.hc_shadow_failure() + ")");
    g_expected_shadow_mismatches += m.stats().hc_shadow_mismatches;
  }
  // The honest twin: the same drive with the oracle on finds nothing.
  {
    Mirror m;
    m.set_hc_shadow(true, grc::rs2::ProtocolVersion::V8);
    build_hc4a_scene(&m);
    Xform moved = kRootXform;
    for (uint64_t frame = 2; frame < 6; ++frame) {
      moved[4] = static_cast<float>(frame);
      for (uint64_t i = 0; i < 40; ++i) {
        m.set_transform(0x5000 + i, moved, frame);
      }
      m.add_unsupported(0x5000 + frame, "canvas_item_add_lcd_texture_rect_region", frame);
      m.snapshot(frame, frame);
    }
    check(m.stats().hc_shadow_checked == 4 && m.stats().hc_shadow_mismatches == 0,
          "the oracle agrees with an honest mirror (" + m.hc_shadow_failure() + ")");
  }
}

}  // namespace

// Gate 1 (G1a): a node removed from the tree and added back (`D`, steps 8-9 of
// fixtures/gate1) only goes through set_parent(item, RID()) and
// set_parent(item, canvas); its id, state and commands survive, and it is
// re-appended at the end of the canvas list.
void test_detach_reattach_keeps_id() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);  // 1
  m.canvas_item_create(101, 1);  // 2
  m.canvas_item_create(102, 1);  // 3
  m.set_parent(100, kRootCanvas, 1);
  m.set_parent(101, kRootCanvas, 1);
  m.set_parent(102, kRootCanvas, 1);
  m.add_rect(101, kRect, kGreen, false, 1);
  m.set_draw_index(101, 7, 1);
  Snapshot s = m.snapshot(1, 1).state;
  const uint64_t version = item(s, 2)->content_version;

  m.set_parent(101, 0, 81);  // _exit_canvas
  s = m.snapshot(2, 81).state;
  check(item(s, 2) != nullptr, "a detached item keeps its id");
  check(item(s, 2)->parent.kind == ParentKind::None, "a detached item has no parent");
  check(canvas(s, 1)->items == ids({1, 3}), "a detached item is in no list");
  check(item(s, 2)->commands.size() == 1 && item(s, 2)->content_version == version,
        "a detached item keeps its commands and content version");
  check(item(s, 2)->draw_index == 7, "a detached item keeps its draw index");

  m.set_parent(101, kRootCanvas, 91);  // _enter_canvas
  s = m.snapshot(3, 91).state;
  check(item(s, 2) != nullptr && s.items.size() == 3, "re-attaching creates no new id");
  check(item(s, 2)->parent.kind == ParentKind::Canvas && item(s, 2)->parent.id == 1,
        "the re-attached item's parent is canvas 1 again");
  check(canvas(s, 1)->items == ids({1, 3, 2}), "the re-attached item is appended at the end");
  check(s.failures.empty(), "detach and re-attach raise no failure");
}

// Gate 1 (G1a): freeing a raw RenderingServer parent (`Y`, step 8) orphans its
// child (`X`), which stays alive, detached and in no list until its own free.
void test_raw_parent_free_leaves_detached_child() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(300, 1);  // 1: Y
  m.set_parent(300, kRootCanvas, 1);
  m.set_draw_index(300, 1000, 1);
  m.add_rect(300, kRect, kRed, false, 1);
  m.canvas_item_create(301, 1);  // 2: X
  m.set_parent(301, 300, 1);
  m.add_rect(301, kRect, kGreen, false, 1);

  m.free_rid(300, 81);
  Snapshot s = m.snapshot(1, 81).state;
  check(item(s, 1) == nullptr, "the freed parent Y is gone");
  check(item(s, 2) != nullptr, "its child X is still alive");
  check(item(s, 2)->parent.kind == ParentKind::None, "X is detached");
  check(canvas(s, 1)->items.empty(), "Y left the root canvas and X is in no list");
  check(item(s, 2)->commands.size() == 1, "X keeps its commands");
  check(s.failures.empty(), "freeing a parent raises no failure");

  // X can still be addressed by its own RID, and freed later.
  m.set_visible(301, false, 85);
  s = m.snapshot(2, 85).state;
  check(s.failures.empty() && !item(s, 2)->visible, "the orphan is still a known item");
  m.free_rid(301, 91);
  s = m.snapshot(3, 91).state;
  check(s.items.empty(), "freeing the orphan removes it");
  check(m.stats().free_unknown == 0, "neither free was of an unknown RID");
}

// --- gate 1 (G1b2) -------------------------------------------------------------

// z_relative / behind start at the RenderingServer defaults until their setters tap (G1e).
void test_rs_defaults() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  const Snapshot s = m.snapshot(1, 1).state;
  check(item(s, 1)->z_relative && !item(s, 1)->behind,
        "a new item has z_relative true and behind false (RS defaults)");
}

// G1e: canvas_item_set_z_as_relative_to_parent / canvas_item_set_draw_behind_parent.
void test_set_z_relative_and_behind() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_z_relative(100, false, 1);
  m.set_behind(100, true, 1);
  const Snapshot s = m.snapshot(1, 1).state;
  check(!item(s, 1)->z_relative && item(s, 1)->behind,
        "set_z_relative(false) and set_behind(true) are stored");

  Mirror n;
  bind_root(&n);
  n.canvas_item_create(100, 1);
  n.set_omit_op("canvas_item_set_z_as_relative_to_parent", 5);
  n.set_z_relative(100, false, 5);
  n.set_behind(100, true, 5);
  const Snapshot t = n.snapshot(1, 5).state;
  check(item(t, 1)->z_relative && item(t, 1)->behind,
        "omit-op drops only canvas_item_set_z_as_relative_to_parent");
  check(n.stats().dropped_omit_op == 1, "exactly the one matching tap was dropped");
}

// Three top-level items on canvas 1 at RIDs 100.. with one add_rect each.
void drawing_siblings(Mirror *m, int count) {
  for (int i = 0; i < count; ++i) {
    const uint64_t rid = 100 + static_cast<uint64_t>(i);
    m->canvas_item_create(rid, 1);
    m->set_parent(rid, kRootCanvas, 1);
    m->add_rect(rid, kRect, kRed, false, 1);
  }
}

void test_tie_two_siblings() {
  Mirror m;
  bind_root(&m);
  drawing_siblings(&m, 2);
  const Snapshot s = m.snapshot(1, 1).state;
  check(ties(s) == std::vector<Entry>{tie(1)},
        "two drawing siblings at draw_index 0 on canvas 1 -> one tie entry at the smaller id");
  check(s.failures.empty(), "a tie is unsupported, not a capture failure");
}

void test_tie_non_drawing_never_ties() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);  // 1: no commands, no children
  m.canvas_item_create(101, 1);  // 2: no commands, no children
  m.set_parent(100, kRootCanvas, 1);
  m.set_parent(101, kRootCanvas, 1);
  check(ties(m.snapshot(1, 1).state).empty(), "two non-drawing siblings never tie");
  m.add_rect(101, kRect, kRed, false, 2);
  check(ties(m.snapshot(2, 2).state).empty(), "one drawing and one non-drawing sibling do not tie");
  // A cleared item stops drawing.
  m.canvas_item_create(102, 3);  // 3
  m.set_parent(102, kRootCanvas, 3);
  m.add_rect(102, kRect, kGreen, false, 3);
  check(ties(m.snapshot(3, 3).state) == std::vector<Entry>{tie(2)}, "two drawing siblings tie");
  m.clear(102, 4);
  check(ties(m.snapshot(4, 4).state).empty(), "clear empties the commands: no longer drawing");
}

void test_tie_children_only_counts_as_drawing() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);  // 1: non-drawing sibling
  m.canvas_item_create(101, 1);  // 2: children only
  m.canvas_item_create(102, 1);  // 3: commands
  m.canvas_item_create(103, 1);  // 4: child of 2, no commands
  m.set_parent(100, kRootCanvas, 1);
  m.set_parent(101, kRootCanvas, 1);
  m.set_parent(102, kRootCanvas, 1);
  m.set_parent(103, 101, 1);
  m.add_rect(102, kRect, kRed, false, 1);
  const Snapshot s = m.snapshot(1, 1).state;
  check(ties(s) == std::vector<Entry>{tie(2)},
        "an item with only children is drawing; the entry names the smallest drawing id");
}

void test_tie_three_way() {
  Mirror m;
  bind_root(&m);
  drawing_siblings(&m, 3);
  check(ties(m.snapshot(1, 1).state) == std::vector<Entry>{tie(1)}, "a three-way tie is one entry");
  m.set_draw_index(100, 5, 2);
  check(ties(m.snapshot(2, 2).state) == std::vector<Entry>{tie(2)},
        "moving the smallest out leaves a tie named by the next smallest");
}

void test_tie_under_item_children() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);  // 1: P
  m.canvas_item_create(101, 1);  // 2: C1
  m.canvas_item_create(102, 1);  // 3: C2
  m.set_parent(100, kRootCanvas, 1);
  m.set_parent(102, 100, 1);
  m.set_parent(101, 100, 1);
  m.add_rect(101, kRect, kRed, false, 1);
  m.add_rect(102, kRect, kGreen, false, 1);
  Snapshot s = m.snapshot(1, 1).state;
  check(ties(s) == std::vector<Entry>{tie(2)},
        "two drawing children of an item tie; the entry names the smaller id");
  m.set_draw_index(101, 1, 2);
  m.set_draw_index(102, 0, 2);
  s = m.snapshot(2, 2).state;
  check(ties(s).empty(), "distinct indices under an item: no tie");
}

void test_tie_resolved_by_set_draw_index() {
  Mirror m;
  bind_root(&m);
  drawing_siblings(&m, 2);
  check(ties(m.snapshot(1, 1).state).size() == 1, "tied first");
  m.set_draw_index(101, 1, 2);
  const Snapshot s = m.snapshot(2, 2).state;
  check(ties(s).empty() && s.unsupported.empty(), "set_draw_index resolving the tie removes it");
}

void test_tie_ordering_with_unsupported_op() {
  Mirror m;
  bind_root(&m);
  drawing_siblings(&m, 2);
  m.add_unsupported(100, "canvas_item_add_circle", 1);
  m.set_material(101, 0x77, 1);
  m.viewport_attach_canvas(0x9999, kRootCanvas, 1);  // a session-level entry
  const Snapshot s = m.snapshot(1, 1).state;
  check(!s.unsupported.empty() && !s.unsupported[0].has_item,
        "session-level entries come before item-level ones");
  const std::vector<Entry> expected = {
      {1, "canvas_item_add_circle", UnsupportedReason::UnsupportedOp},
      tie(1),
      {2, "canvas_item_set_material", UnsupportedReason::UnknownMaterial},
  };
  check(item_entries(s) == expected,
        "item-level entries by item id, then op byte order "
        "(canvas_item_add_circle < canvas_item_set_draw_index)");
}

// G1a runtime case: a node entering the tree is appended at the RS default
// draw index 0 before the deferred _top_level_raise_self gives every
// top-level item a fresh index (gate1-design.md Q2c).
void test_tie_new_top_level_item_until_raise() {
  Mirror m;
  bind_root(&m);
  drawing_siblings(&m, 2);
  m.set_draw_index(100, 0, 1);
  m.set_draw_index(101, 1, 1);
  check(ties(m.snapshot(1, 1).state).empty(), "raised siblings do not tie");
  m.canvas_item_create(102, 2);  // 3
  m.set_parent(102, kRootCanvas, 2);
  m.add_rect(102, kRect, kGreen, false, 2);
  check(ties(m.snapshot(2, 2).state) == std::vector<Entry>{tie(1)},
        "a new top-level item at default index 0 ties with the existing index-0 sibling");
  m.set_draw_index(100, 2, 3);
  m.set_draw_index(101, 3, 3);
  m.set_draw_index(102, 4, 3);
  check(ties(m.snapshot(3, 3).state).empty(), "the tie is gone after the raise");
}

void test_degenerate_host_size_first() {
  Mirror m;
  bind_root(&m);
  m.viewport_attach_canvas(0x9999, kRootCanvas, 1);  // observed first
  m.set_degenerate_host_size(true);
  drawing_siblings(&m, 2);  // and a tie
  Snapshot s = m.snapshot(1, 1).state;
  check(s.unsupported.size() == 3, "degenerate, non-root-viewport, tie");
  if (s.unsupported.size() == 3) {
    check(!s.unsupported[0].has_item && s.unsupported[0].op == "root_viewport_size" &&
              s.unsupported[0].reason == UnsupportedReason::DegenerateHostSize,
          "degenerate-host-size is the first entry even when observed after another");
    check(std::string(grc::rs2::to_wire(s.unsupported[0].reason)) == "degenerate-host-size",
          "wire spelling degenerate-host-size");
    check(s.unsupported[1].reason == UnsupportedReason::NonRootViewport,
          "then the other session-level entries");
    check(s.unsupported[2].reason == UnsupportedReason::DrawIndexTie, "then item-level entries");
  }
  check(s.failures.empty(), "degenerate-host-size is unsupported, not a failure");
  m.set_draw_index(100, 9, 2);
  s = m.snapshot(2, 50).state;
  check(s.unsupported.size() == 2 && s.unsupported[0].op == "root_viewport_size",
        "present in every later snapshot");
  m.set_degenerate_host_size(false);
  check(m.snapshot(3, 51).state.unsupported.size() == 1, "off removes it");
  m.set_degenerate_host_size(true);
  m.reset();
  check(m.snapshot(4, 52).state.unsupported.empty(), "reset() clears it");
}

void test_root_size_enforce_failed() {
  Mirror m;
  bind_root(&m);
  m.fail_root_size_enforce("degenerate-visible: window 64x64, visible 64x64, logical 640x360");
  m.fail_root_size_enforce("again");
  m.canvas_item_create(100, 2);
  Snapshot s = m.snapshot(1, 2).state;
  check(s.failures.size() == 1 && s.failures[0].reason == FailureReason::RootSizeEnforceFailed &&
            s.failures[0].detail ==
                "degenerate-visible: window 64x64, visible 64x64, logical 640x360",
        "root-size-enforce-failed is sticky and keeps the first detail");
  check(std::string(grc::rs2::to_wire(s.failures[0].reason)) == "root-size-enforce-failed",
        "wire spelling root-size-enforce-failed");
  check(s.status() == grc::rs2::TransactionStatus::CaptureFailure, "status capture-failure");
  m.fail_root_query("Viewport.get_world_2d");
  s = m.snapshot(2, 3).state;
  check(s.failures.size() == 2 && has_failure(s, FailureReason::RootQueryFailed),
        "it is a reason of its own, not a root-query-failed detail");
  m.reset();
  check(m.snapshot(3, 4).state.failures.empty(), "reset() clears it");
}

void test_omit_op_free() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);  // 1: A, on canvas 1
  m.canvas_item_create(101, 1);  // 2: B, child of A
  m.canvas_item_create(102, 1);  // 3: C, on canvas 1
  m.set_parent(100, kRootCanvas, 1);
  m.set_parent(101, 100, 1);
  m.set_parent(102, kRootCanvas, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  m.set_omit_op("free", 10);

  m.free_rid(102, 9);  // F-1: applies
  Snapshot s = m.snapshot(1, 9).state;
  check(item(s, 3) == nullptr && canvas(s, 1)->items == ids({1}), "a free at F-1 applies");

  m.free_rid(100, 10);  // F: dropped
  s = m.snapshot(2, 10).state;
  check(item(s, 1) != nullptr && item(s, 1)->parent.kind == ParentKind::Canvas &&
            item(s, 1)->parent.id == 1 && canvas(s, 1)->items == ids({1}),
        "omit-op free at F keeps the item and its parent link");
  check(item(s, 1)->children == ids({2}) && item(s, 2)->parent.kind == ParentKind::Item,
        "its child is not orphaned");
  check(item(s, 1)->commands.size() == 1, "it keeps its commands");

  m.free_rid(101, 11);  // later frame: dropped
  s = m.snapshot(3, 11).state;
  check(item(s, 2) != nullptr && item(s, 2)->parent.kind == ParentKind::Item &&
            item(s, 2)->parent.id == 1,
        "omit-op free at a later frame keeps the child and its parent link");
  check(m.stats().dropped_omit_op == 2, "two frees counted as dropped_omit_op");
  check(m.stats().free_unknown == 0, "a dropped free is not an unknown free");

  // The RID is still known: a later call on it is no pre-existing-object.
  m.set_visible(100, false, 12);
  s = m.snapshot(4, 12).state;
  check(s.failures.empty() && !item(s, 1)->visible, "the kept item still takes updates");

  m.set_omit_op("", 0);
  m.free_rid(100, 13);
  check(item(m.snapshot(5, 13).state, 1) == nullptr, "an empty op disables omit-op");
}

void test_omit_op_visible_only() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_omit_op("canvas_item_set_visible", 6);
  m.set_visible(100, false, 5);  // before F: applies
  Snapshot s = m.snapshot(1, 5).state;
  check(!item(s, 1)->visible, "set_visible before F applies");
  m.set_visible(100, true, 6);  // F: dropped
  m.set_modulate(100, kRed, 6);
  m.set_self_modulate(100, kGreen, 6);
  m.set_z_index(100, 2, 6);
  m.add_rect(100, kRect, kRed, false, 6);
  m.set_visible(100, true, 7);  // later: dropped
  m.free_rid(100, 8);           // not the omitted op: applies
  s = m.snapshot(2, 7).state;
  check(item(s, 1) == nullptr, "free is not the omitted op");
  check(m.stats().dropped_omit_op == 2, "only the two set_visible calls were dropped");

  Mirror n;
  bind_root(&n);
  n.canvas_item_create(100, 1);
  n.set_omit_op("canvas_item_set_visible", 6);
  n.set_visible(100, false, 6);
  n.set_modulate(100, kRed, 6);
  n.add_rect(100, kRect, kRed, false, 6);
  s = n.snapshot(1, 6).state;
  check(item(s, 1)->visible && item(s, 1)->modulate == kRed && item(s, 1)->commands.size() == 1,
        "omit-op canvas_item_set_visible drops only that op");
  check(n.stats().dropped_omit_update == 0, "omit-op is not counted as omit-update");
}

void test_omit_op_identity_creates() {
  Mirror m;
  bind_root(&m);
  m.set_omit_op("canvas_item_create", 3);
  m.canvas_item_create(100, 2);  // applies
  m.canvas_item_create(101, 3);  // dropped
  m.set_parent(101, kRootCanvas, 3);
  Snapshot s = m.snapshot(1, 3).state;
  check(s.items.size() == 1 && item(s, 1) != nullptr, "canvas_item_create at F is dropped");
  check(has_failure(s, FailureReason::PreExistingObject),
        "the dropped item is unknown to later calls (identity ops are not exempt)");

  Mirror n;
  bind_root(&n);
  n.set_omit_op("canvas_create", 1);
  n.canvas_create(200, 1);
  check(n.snapshot(1, 1).state.canvases.size() == 1 && n.stats().dropped_omit_op == 1,
        "omit-op canvas_create drops the create");
  n.set_omit_op("viewport_set_canvas_transform", 1);
  n.viewport_set_canvas_transform(kRootViewport, kRootCanvas, {2, 0, 0, 2, 0, 0}, 1);
  check(canvas(n.snapshot(2, 1).state, 1)->xform == kRootXform, "omit-op on a viewport op");
  n.set_omit_op("canvas_item_add_circle", 1);
  n.canvas_item_create(100, 1);
  n.add_unsupported(100, "canvas_item_add_circle", 1);
  n.add_unsupported(100, "canvas_item_add_line", 1);
  s = n.snapshot(3, 1).state;
  check(item(s, 1)->commands.size() == 1 && item(s, 1)->commands[0].name == "canvas_item_add_line",
        "an unsupported add op is omitted by its own name");
}

void test_epoch() {
  Mirror m;
  bind_root(&m);
  m.set_drop_frame(5);
  m.set_omit_op("canvas_item_set_clip", 1);
  uint64_t e = m.epoch();
  m.canvas_item_create(100, 1);
  check(m.epoch() == e + 1, "an applied create advances the epoch");
  e = m.epoch();
  m.set_transform(100, {1, 0, 0, 1, 3, 4}, 2);
  check(m.epoch() == e + 1, "an applied setter advances the epoch");
  e = m.epoch();
  m.set_transform(100, {1, 0, 0, 1, 5, 6}, 5);
  check(m.epoch() == e, "a tap dropped by omit-update does not");
  m.set_clip(100, true, 2);
  check(m.epoch() == e, "a tap dropped by omit-op does not");
  m.free_rid(0x5151, 2);
  check(m.epoch() == e, "a free of an untracked RID (texture, mesh) does not");
  (void)m.snapshot(1, 2).state;
  (void)m.stats();
  check(m.epoch() == e, "reading does not");
  m.add_rect(100, kRect, kRed, false, 3);
  m.set_visible(100, false, 3);
  check(m.epoch() == e + 2, "every applied tap counts");
  e = m.epoch();
  m.set_visible(0x7777, false, 3);  // unknown RID: a failure is recorded
  check(m.epoch() == e + 1, "an applied tap on an unknown RID counts (the failure changed)");
  e = m.epoch();
  m.free_rid(100, 4);
  check(m.epoch() == e + 1, "a free of a tracked item counts");
  e = m.epoch();
  m.set_degenerate_host_size(true);
  check(m.epoch() == e + 1, "session-level setters count");
  e = m.epoch();
  m.reset();
  check(m.epoch() > e, "reset() never takes the epoch back");
}

void test_process_wide_g1b2() {
  using namespace grc::rs;
  mirror_enable(true);
  mirror_set_root(kRootViewport, kRootCanvas, kRootXform);
  const uint64_t e = mirror_epoch();
  mirror_instance().canvas_item_create(100, 1);
  check(mirror_epoch() == e + 1, "mirror_epoch");
  mirror_set_degenerate_host_size(true);
  mirror_fail_root_size_enforce("enforce");
  mirror_set_omit_op("canvas_item_set_z_index", 2);
  mirror_instance().set_z_index(100, 3, 2);
  Snapshot s = mirror_snapshot(1, 2).state;
  check(!s.unsupported.empty() && s.unsupported[0].op == "root_viewport_size",
        "mirror_set_degenerate_host_size");
  check(has_failure(s, FailureReason::RootSizeEnforceFailed), "mirror_fail_root_size_enforce");
  check(s.items.size() == 1 && s.items[0].z_index == 0 && mirror_stats().dropped_omit_op == 1,
        "mirror_set_omit_op");
  mirror_enable(false);
}

// --- textures (gate 2, G2b2; gate2-design.md Q3 "Texture mirror") ----------------------------

grc::rs::PayloadCopy rgba8_copy(int64_t w, int64_t h, const std::vector<uint8_t> &data,
                                grc::rs::PayloadPtr *bytes) {
  grc::rs::PayloadCopy copy;
  copy.status = "ok";
  copy.format = 5;  // RGBA8
  copy.width = w;
  copy.height = h;
  copy.mipmaps_known = true;
  copy.mipmaps = false;
  copy.data_bytes = static_cast<int64_t>(data.size());
  auto payload = std::make_shared<grc::rs::PayloadBytes>(
      grc::rs::encode_payload(5, w, h, false, data.data(), data.size()));
  copy.payload_bytes = static_cast<int64_t>(payload->size());
  copy.hash = grc::sha256_hex(payload->data(), payload->size());
  *bytes = payload;
  return copy;
}

std::vector<uint8_t> fill(int64_t w, int64_t h, uint8_t value) {
  return std::vector<uint8_t>(static_cast<std::size_t>(w * h * 4), value);
}

const grc::rs2::TextureEntry *texture(const Snapshot &s, uint32_t id) {
  for (const auto &t : s.textures) {
    if (t.id == id) return &t;
  }
  return nullptr;
}

// One item on the root canvas drawing `tex` with add_texture_rect (its own draw index, so
// sibling drawers never tie).
void drawing_item(Mirror *m, uint64_t item_rid, uint64_t tex_rid, uint64_t frame) {
  m->canvas_item_create(item_rid, frame);
  m->set_parent(item_rid, kRootCanvas, frame);
  m->set_draw_index(item_rid, static_cast<int32_t>(item_rid), frame);
  m->add_texture_rect(item_rid, kRect, tex_rid, false, kRed, false, frame);
}

void test_texture_ids_versions_and_payloads() {
  Mirror m;
  bind_root(&m);
  grc::rs::PayloadPtr a_bytes;
  const auto a0 = rgba8_copy(4, 4, fill(4, 4, 10), &a_bytes);
  m.texture_2d_create(500, a0, a_bytes, 1);           // id 1
  m.texture_2d_placeholder_create(501, 1);              // id 2
  grc::rs::PayloadPtr twin_bytes;
  const auto twin = rgba8_copy(4, 4, fill(4, 4, 10), &twin_bytes);
  m.texture_2d_create(502, twin, twin_bytes, 1);        // id 3, same hash as id 1
  drawing_item(&m, 100, 500, 1);
  m.add_texture_rect_region(100, kRect, 502, kRect, kGreen, true, true, 1);
  m.add_texture_rect(100, kRect, 0, true, kRed, false, 1);  // RID() -> tex null
  grc::rs::Captured c = m.snapshot(1, 1);
  const Snapshot &s = c.state;
  check(s.textures.size() == 3 && s.textures[0].id == 1 && s.textures[1].id == 2 &&
            s.textures[2].id == 3,
        "texture ids from one counter, every kind, sorted by id");
  check(texture(s, 1)->kind == grc::rs2::TextureKind::Image &&
            texture(s, 1)->status == grc::rs2::TextureStatus::Ok && texture(s, 1)->version == 1 &&
            texture(s, 1)->has_hash && texture(s, 1)->hash == a0.hash &&
            texture(s, 1)->format == "RGBA8" && texture(s, 1)->width == 4 &&
            texture(s, 1)->payload_bytes == static_cast<uint64_t>(a0.payload_bytes),
        "an ok image entry carries its hash, shape and payload size");
  check(texture(s, 2)->kind == grc::rs2::TextureKind::Placeholder && !texture(s, 2)->has_hash &&
            !texture(s, 2)->has_format && texture(s, 2)->width == 0,
        "a placeholder entry has no shape");
  check(texture(s, 3)->hash == texture(s, 1)->hash && c.payloads.size() == 1 &&
            c.payloads.count(a0.hash) == 1 && c.payloads.at(a0.hash)->size() ==
                                                   static_cast<std::size_t>(a0.payload_bytes),
        "equal bytes share one hash and one payload, but keep two ids");
  const auto *i = item(s, 1);
  check(i != nullptr && i->commands.size() == 3 &&
            i->commands[0].kind == CommandKind::AddTextureRect && i->commands[0].has_tex &&
            i->commands[0].tex == 1 &&
            i->commands[1].kind == CommandKind::AddTextureRectRegion && i->commands[1].tex == 3 &&
            i->commands[1].transpose && i->commands[1].clip_uv &&
            i->commands[2].kind == CommandKind::AddTextureRect && !i->commands[2].has_tex &&
            i->commands[2].tile && i->content_version == 3,
        "texture draws keep their raw arguments and name wire ids (RID() -> null)");
  check(item_entries(s).empty(), "no unsupported entry for supported textures");

  // An update with the same shape: version + 1, a new payload, the same id.
  grc::rs::PayloadPtr a1_bytes;
  const auto a1 = rgba8_copy(4, 4, fill(4, 4, 20), &a1_bytes);
  m.texture_2d_update(500, a1, a1_bytes, 0, 2);
  c = m.snapshot(2, 2);
  check(texture(c.state, 1)->version == 2 && texture(c.state, 1)->hash == a1.hash &&
            c.payloads.count(a1.hash) == 1 && c.payloads.count(a0.hash) == 1,
        "texture_2d_update: version + 1, new hash; the twin keeps the old payload alive");
  // A shape change through update is unsupported (update-shape-mismatch), a layer too.
  grc::rs::PayloadPtr big_bytes;
  const auto big = rgba8_copy(8, 8, fill(8, 8, 30), &big_bytes);
  m.texture_2d_update(502, big, big_bytes, 0, 3);
  m.texture_2d_update(500, a1, a1_bytes, 1, 3);
  c = m.snapshot(3, 3);
  check(texture(c.state, 3)->status == grc::rs2::TextureStatus::Unsupported &&
            texture(c.state, 3)->has_reason &&
            texture(c.state, 3)->reason == grc::rs2::TextureReason::UpdateShapeMismatch &&
            !texture(c.state, 3)->has_hash && texture(c.state, 3)->payload_bytes == 0 &&
            texture(c.state, 3)->version == 2,
        "an update with another shape: unsupported update-shape-mismatch, version + 1");
  check(texture(c.state, 1)->reason == grc::rs2::TextureReason::LayeredUpdate &&
            c.payloads.empty(),
        "a layered update: unsupported layered-update; no ok payload left");
  check(item_entries(c.state) ==
            std::vector<Entry>{{1, "canvas_item_add_texture_rect",
                                UnsupportedReason::UnsupportedTexture},
                               {1, "canvas_item_add_texture_rect_region",
                                UnsupportedReason::UnsupportedTexture}},
        "a draw naming an unsupported texture adds unsupported-texture per (op, reason)");
  // An update of a RID never seen created changes nothing.
  m.texture_2d_update(999, a1, a1_bytes, 0, 3);
  check(m.stats().texture_update_unknown == 1, "an unknown update is counted only");
}

void test_texture_replace_free_and_tombstones() {
  Mirror m;
  bind_root(&m);
  grc::rs::PayloadPtr a_bytes;
  const auto a = rgba8_copy(4, 4, fill(4, 4, 1), &a_bytes);
  m.texture_2d_create(500, a, a_bytes, 1);   // id 1 (A)
  m.texture_2d_placeholder_create(501, 1);   // id 2 (P1)
  m.texture_2d_placeholder_create(502, 1);   // id 3 (P2)
  drawing_item(&m, 100, 500, 1);
  drawing_item(&m, 101, 501, 1);
  drawing_item(&m, 102, 502, 1);
  m.snapshot(1, 1);

  // set_image: create + replace in one frame. The temporary id never reaches a snapshot.
  grc::rs::PayloadPtr a2_bytes;
  const auto a2 = rgba8_copy(8, 8, fill(8, 8, 2), &a2_bytes);
  m.texture_2d_create(510, a2, a2_bytes, 2);  // id 4 (temporary)
  m.texture_replace(500, 510, 2);
  grc::rs::Captured c = m.snapshot(2, 2);
  check(texture(c.state, 1)->version == 2 && texture(c.state, 1)->hash == a2.hash &&
            texture(c.state, 1)->width == 8 && texture(c.state, 4) == nullptr,
        "texture_replace: t takes b's content at version + 1, b's id leaves the table");
  // The by-texture's RID is gone: a draw naming it is unknown-texture.
  m.add_texture_rect(100, kRect, 510, false, kRed, false, 2);
  c = m.snapshot(3, 3);
  check(item(c.state, 1)->commands.back().kind == CommandKind::Unsupported &&
            item(c.state, 1)->commands.back().unsupported_reason ==
                grc::rs2::UnsupportedCmdReason::UnknownTexture &&
            item_entries(c.state) ==
                std::vector<Entry>{{1, "canvas_item_add_texture_rect",
                                    UnsupportedReason::UnknownTexture}},
        "a draw naming an unknown RID is an unsupported unknown-texture command");

  // Placeholder -> image through replace (kind change); P1 freed while still drawn.
  grc::rs::PayloadPtr e_bytes;
  const auto e = rgba8_copy(4, 4, fill(4, 4, 3), &e_bytes);
  m.texture_2d_create(520, e, e_bytes, 4);  // id 5
  m.texture_replace(502, 520, 4);
  m.free_rid(501, 4);
  c = m.snapshot(4, 4);
  check(texture(c.state, 3)->kind == grc::rs2::TextureKind::Image &&
            texture(c.state, 3)->version == 2 && texture(c.state, 3)->hash == e.hash &&
            texture(c.state, 5) == nullptr,
        "a placeholder becomes an image through replace (same id, kind change)");
  check(texture(c.state, 2) != nullptr &&
            texture(c.state, 2)->status == grc::rs2::TextureStatus::Freed &&
            texture(c.state, 2)->version == 1 && !texture(c.state, 2)->has_hash &&
            texture(c.state, 2)->kind == grc::rs2::TextureKind::Placeholder,
        "a freed texture a command still names is a freed tombstone, version unchanged");
  // The tombstone leaves the table at the first snapshot in which nothing names it.
  m.clear(101, 5);
  c = m.snapshot(5, 5);
  check(texture(c.state, 2) == nullptr, "an unreferenced tombstone leaves the table");
  // Free of an unreferenced texture: the id leaves at once.
  m.free_rid(500, 6);
  m.clear(100, 6);
  c = m.snapshot(6, 6);
  check(texture(c.state, 1) == nullptr && m.stats().free_unknown == 0,
        "free: a texture leaves the table; a texture free is not free_unknown");
  // A new texture gets an id above every earlier one.
  m.texture_2d_placeholder_create(530, 7);
  c = m.snapshot(7, 7);
  check(c.state.textures.back().id == 6, "ids are never reused");
}

void test_texture_unsupported_copies_and_filters() {
  Mirror m;
  bind_root(&m);
  grc::rs::PayloadCopy refused;
  refused.status = "unsupported";
  refused.reason = "unsupported-format";
  refused.format = 11;  // RGBAF
  refused.width = 4;
  refused.height = 4;
  refused.mipmaps_known = true;
  m.texture_2d_create(500, refused, nullptr, 1);
  drawing_item(&m, 100, 500, 1);
  m.set_texture_filter(100, 2, 1);
  m.set_texture_repeat(100, 3, 1);
  m.set_texture_filter(100, 99, 1);  // out of range: ignored
  m.set_texture_defaults(grc::rs2::Filter::Nearest, grc::rs2::Repeat::Disabled);
  m.viewport_set_texture_filter(kRootViewport, 2, 2);
  m.viewport_set_texture_filter(kRootViewport, 0, 2);  // DEFAULT: refused by the server
  m.viewport_set_texture_repeat(0x9999, 2, 2);         // another viewport
  m.add_unsupported(100, "canvas_item_add_lcd_texture_rect_region", 2);
  const Snapshot s = m.snapshot(1, 2).state;
  const auto *t = texture(s, 1);
  check(t != nullptr && t->status == grc::rs2::TextureStatus::Unsupported &&
            t->reason == grc::rs2::TextureReason::UnsupportedFormat && t->format == "RGBAF" &&
            t->width == 4 && !t->has_hash && t->payload_bytes == 0,
        "an unsupported-format copy is an unsupported entry with its shape and no hash");
  check(item(s, 1)->texture_filter == grc::rs2::Filter::Linear &&
            item(s, 1)->texture_repeat == grc::rs2::Repeat::Mirror &&
            item(s, 1)->content_version == 2,
        "item filter/repeat are item fields, not content");
  check(s.default_texture_filter == grc::rs2::Filter::Linear &&
            s.default_texture_repeat == grc::rs2::Repeat::Disabled,
        "the root viewport default filter/repeat are transaction scalars");
  bool non_root = false;
  for (const auto &u : s.unsupported) {
    non_root = non_root || (!u.has_item && u.reason == UnsupportedReason::NonRootViewport &&
                            u.op == "viewport_set_default_canvas_item_texture_repeat");
  }
  check(non_root, "another viewport's default is the session-level non-root-viewport entry");
  check(item_entries(s) ==
            std::vector<Entry>{{1, "canvas_item_add_lcd_texture_rect_region",
                                UnsupportedReason::UnsupportedOp},
                               {1, "canvas_item_add_texture_rect",
                                UnsupportedReason::UnsupportedTexture}},
        "item-level entries ordered by op then reason");
}

// gate2-design.md Q3 "canvas_texture_create / canvas_texture_set_*" (G2d), render-stream-2.md
// "Texture" (kind canvas) and "Item-level unsupported entries" (the diffuse chain).
void test_canvas_texture() {
  Mirror m;
  bind_root(&m);
  grc::rs::PayloadPtr a_bytes;
  const auto a = rgba8_copy(4, 4, fill(4, 4, 1), &a_bytes);
  m.texture_2d_create(500, a, a_bytes, 1);  // id 1 (A)
  m.canvas_texture_create(600, 1);          // id 2 (CT)
  drawing_item(&m, 100, 600, 1);             // names CT, not A, directly
  Snapshot s = m.snapshot(1, 1).state;
  const auto *ct = texture(s, 2);
  check(ct != nullptr && ct->kind == grc::rs2::TextureKind::Canvas &&
            ct->status == grc::rs2::TextureStatus::Ok && ct->version == 1 &&
            ct->has_canvas && !ct->canvas.has_diffuse &&
            ct->canvas.filter == grc::rs2::Filter::Default &&
            ct->canvas.repeat == grc::rs2::Repeat::Default,
        "canvas_texture_create: new id, kind canvas, {diffuse: null, filter/repeat: default}");
  check(item(s, 1)->commands.back().kind == CommandKind::AddTextureRect &&
            item(s, 1)->commands.back().has_tex && item(s, 1)->commands.back().tex == 2,
        "a draw naming a canvas texture resolves it exactly like an image");

  const uint64_t e1 = m.epoch();
  m.canvas_texture_set_channel(600, 0, 500, 2);  // DIFFUSE <- A
  m.canvas_texture_set_filter(600, 1, 2);        // NEAREST
  m.canvas_texture_set_repeat(600, 2, 2);        // ENABLED
  check(m.epoch() > e1, "canvas_texture_set_* bump the mutation epoch");
  s = m.snapshot(2, 2).state;
  ct = texture(s, 2);
  check(ct->version == 4 && ct->canvas.has_diffuse && ct->canvas.diffuse == 1 &&
            ct->canvas.filter == grc::rs2::Filter::Nearest &&
            ct->canvas.repeat == grc::rs2::Repeat::Enabled && ct->status == grc::rs2::TextureStatus::Ok,
        "diffuse, filter and repeat each bump version by one on an actual change");

  // Re-setting the same filter is not a change: no version bump.
  m.canvas_texture_set_filter(600, 1, 3);
  s = m.snapshot(3, 3).state;
  check(texture(s, 2)->version == 4, "setting the same filter again does not bump version");

  // A normal (or specular) channel set to a non-null texture makes the entry unsupported.
  m.canvas_texture_set_channel(600, 1, 999, 4);  // NORMAL <- some RID (its id is irrelevant)
  s = m.snapshot(4, 4).state;
  ct = texture(s, 2);
  check(ct->version == 5 && ct->status == grc::rs2::TextureStatus::Unsupported && ct->has_reason &&
            ct->reason == grc::rs2::TextureReason::CanvasTextureChannel && ct->has_canvas &&
            ct->canvas.has_diffuse,
        "a non-null normal channel: unsupported canvas-texture-channel, diffuse unchanged");
  check(item_entries(s) == std::vector<Entry>{{1, "canvas_item_add_texture_rect",
                                               UnsupportedReason::UnsupportedTexture}},
        "a draw naming the now-unsupported canvas texture gets the derived entry");

  // Clearing it back to null makes the entry ok again.
  m.canvas_texture_set_channel(600, 1, 0, 5);  // NORMAL <- null
  s = m.snapshot(5, 5).state;
  check(texture(s, 2)->status == grc::rs2::TextureStatus::Ok && texture(s, 2)->version == 6,
        "clearing the normal channel back to null makes the entry ok again");

  // A diffuse set to a RID the mirror never saw created: unsupported unknown-texture, diffuse null.
  m.canvas_texture_set_channel(600, 0, 777, 6);
  s = m.snapshot(6, 6).state;
  ct = texture(s, 2);
  check(ct->status == grc::rs2::TextureStatus::Unsupported &&
            ct->reason == grc::rs2::TextureReason::UnknownTexture && !ct->canvas.has_diffuse,
        "an unresolvable diffuse RID: unsupported unknown-texture, diffuse null on the wire");

  // A freed image a canvas texture's diffuse still names is a tombstone (not just a command).
  m.canvas_texture_set_channel(600, 0, 500, 7);  // DIFFUSE <- A again
  m.free_rid(500, 7);
  s = m.snapshot(7, 7).state;
  check(texture(s, 1) != nullptr && texture(s, 1)->status == grc::rs2::TextureStatus::Freed,
        "a canvas texture's diffuse keeps a freed image alive as a tombstone");

  // omit-op on canvas_texture_set_texture_filter drops only that call.
  m.set_omit_op("canvas_texture_set_texture_filter", 8);
  const uint64_t before = texture(m.snapshot(8, 8).state, 2)->version;
  m.canvas_texture_set_filter(600, 2, 8);  // would change nearest -> linear if applied
  s = m.snapshot(9, 8).state;
  check(texture(s, 2)->version == before && texture(s, 2)->canvas.filter == grc::rs2::Filter::Nearest,
        "omit-op canvas_texture_set_texture_filter drops the call");
}

// protocol/canvas-texture-headless.md (G2d): on a headless host the dummy storage returns RID()
// for every canvas_texture_create, so a CanvasTexture's draw names RID(). With the flag on, that
// draw is a typed refusal (canvas-texture-headless), never `tex: null` (the white default).
void test_canvas_texture_headless_refusal() {
  Mirror m;
  bind_root(&m);
  m.canvas_texture_create(0, 1);  // RID(): nothing registered
  drawing_item(&m, 100, 0, 1);
  Snapshot s = m.snapshot(1, 1).state;
  check(s.textures.empty() && item(s, 1)->commands.back().kind == CommandKind::AddTextureRect &&
            !item(s, 1)->commands.back().has_tex,
        "flag off: a draw naming RID() is tex null, and RID() registers no canvas texture");

  Mirror h;
  bind_root(&h);
  h.set_canvas_texture_headless(true);
  h.canvas_texture_create(0, 1);
  h.canvas_texture_set_filter(0, 1, 1);  // on RID(): ignored
  drawing_item(&h, 100, 0, 1);
  s = h.snapshot(1, 1).state;
  const auto &cmd = item(s, 1)->commands.back();
  check(s.textures.empty() && cmd.kind == CommandKind::Unsupported &&
            cmd.unsupported_reason == grc::rs2::UnsupportedCmdReason::CanvasTextureHeadless &&
            cmd.name == "canvas_item_add_texture_rect",
        "headless: a draw naming RID() is an unsupported canvas-texture-headless command");
  check(item_entries(s) == std::vector<Entry>{{1, "canvas_item_add_texture_rect",
                                               UnsupportedReason::CanvasTextureHeadless}},
        "headless: the refused draw gets its item-level entry");
  h.reset();
  drawing_item(&h, 100, 0, 1);
  check(!item(h.snapshot(1, 1).state, 1)->commands.back().has_tex &&
            item(h.snapshot(1, 1).state, 1)->commands.back().kind == CommandKind::AddTextureRect,
        "reset() clears the headless flag");
}

void test_texture_omit_op_and_spurious() {
  Mirror m;
  bind_root(&m);
  grc::rs::PayloadPtr a_bytes;
  const auto a = rgba8_copy(4, 4, fill(4, 4, 1), &a_bytes);
  m.texture_2d_create(500, a, a_bytes, 1);
  drawing_item(&m, 100, 500, 1);
  m.set_omit_op("texture_2d_update", 5);
  check(!m.omits("texture_2d_update", 4) && m.omits("texture_2d_update", 5) &&
            !m.omits("texture_replace", 5),
        "omits() answers the omit-op rule");
  grc::rs::PayloadPtr a1_bytes;
  const auto a1 = rgba8_copy(4, 4, fill(4, 4, 2), &a1_bytes);
  const uint64_t e = m.epoch();
  m.texture_2d_update(500, a1, a1_bytes, 0, 5);
  Snapshot s = m.snapshot(1, 5).state;
  check(texture(s, 1)->version == 1 && texture(s, 1)->hash == a.hash && m.epoch() == e,
        "omit-op texture_2d_update drops the update");
  const uint64_t rid = m.spurious_texture_update(6);
  grc::rs::Captured c = m.snapshot(2, 6);
  check(rid == 500 && texture(c.state, 1)->version == 2 && texture(c.state, 1)->hash == a.hash &&
            c.payloads.at(a.hash)->size() == a_bytes->size() &&
            c.payloads.at(a.hash).get() != a_bytes.get(),
        "spurious-texture-update bumps the version and re-copies identical bytes");
}

// gate3-design.md Q3 "Mirror fix" (D3): the engine's Item::clear() sets clip = false and keeps
// custom_rect (servers/rendering/renderer_canvas_render.h:455), so the mirror's clear does too.
void test_clear_resets_clip() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.set_custom_rect(100, true, {0, 0, 64, 48}, 1);
  m.set_clip(100, true, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  check(item(m.snapshot(1, 1).state, 1)->clip, "set_clip(true) stored");
  m.clear(100, 2);
  const Snapshot s = m.snapshot(2, 2).state;
  const auto *it = item(s, 1);
  check(!it->clip, "set_clip(true), clear: clip is false");
  check(it->custom_rect && it->custom_rect_rect == Rect4{0, 0, 64, 48},
        "clear keeps custom_rect and its rect");
  check(it->commands.empty() && it->content_version == 2, "clear empties and bumps as before");
}

void test_clear_then_reassert_clip() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.set_custom_rect(100, true, {0, 0, 64, 48}, 1);
  m.set_clip(100, true, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  const Snapshot base = m.snapshot(1, 1).state;
  // A Control redraw: clear, custom rect, clip, content, all in one frame.
  m.clear(100, 2);
  m.set_custom_rect(100, true, {0, 0, 64, 48}, 2);
  m.set_clip(100, true, 2);
  m.add_rect(100, kRect, kGreen, false, 2);
  const Snapshot cur = m.snapshot(2, 2).state;
  check(item(cur, 1)->clip, "set_clip(true), clear, set_clip(true): clip is true");
  const grc::rs2::Transaction patch = grc::rs2::make_patch(base, cur);
  bool found = false;
  for (const auto &e : patch.items) {
    if (e.state.id != 1) continue;
    found = true;
    check(e.state.clip == item(base, 1)->clip, "the patch entry's clip equals the base's");
    check(!e.commands_null, "the content change carries commands");
  }
  check(found, "the redrawn item is in the patch (content_version changed)");
  const Snapshot resolved = grc::rs2::resolve(base, patch);
  check(item(resolved, 1) != nullptr && item(resolved, 1)->clip,
        "the patch resolves to clip true: no clip change on the wire");
}

void test_omit_clip_then_clear() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  m.set_clip(100, true, 4);  // before the sabotage frame: applies
  check(item(m.snapshot(1, 4).state, 1)->clip, "a set_clip before the omit frame applies");
  m.set_omit_op("canvas_item_set_clip", 5);
  // Frame 5: the redraw's re-assertion is dropped, the clear still resets.
  m.clear(100, 5);
  m.set_clip(100, true, 5);
  m.add_rect(100, kRect, kGreen, false, 5);
  const Snapshot s = m.snapshot(2, 5).state;
  const auto *it = item(s, 1);
  check(!it->clip, "omit-op set_clip, then clear: clip false");
  check(it->commands.size() == 1 && it->commands[0].color == kGreen,
        "nothing of the dropped call applied; the content still changed");
  check(s.failures.empty(), "a dropped set_clip is no failure");
  check(m.stats().dropped_omit_op == 1, "one set_clip counted as dropped_omit_op");
}

// gate3-design.md Q3 "Clip-ignore tap" (G3d, D4): canvas_item_add_clip_ignore joins the generic
// add_unsupported path (`canvas_item_add_rect` neighbours like `canvas_item_add_circle` and
// `canvas_item_add_lcd_texture_rect_region` already exercise it), with reason unsupported-op and
// the `ignore` argument itself kept out of the wire entirely (it is counters.json's job, at the
// hook, not the mirror's).
void test_clip_ignore_tap() {
  // G5d (gate5-design.md D10, render-stream-4.md): canvas_item_add_clip_ignore is the /4
  // add_clip_ignore command, the bool carried, in order; G3d's typed refusal is gone.
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.add_rect(100, kRect, kGreen, false, 1);
  m.add_clip_ignore(100, true, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  m.add_clip_ignore(100, false, 1);
  const Snapshot s = m.snapshot(1, 1).state;
  const auto *it = item(s, 1);
  check(it->commands.size() == 4 && it->commands[1].kind == CommandKind::AddClipIgnore &&
            it->commands[1].clip_ignore && it->commands[3].kind == CommandKind::AddClipIgnore &&
            !it->commands[3].clip_ignore,
        "add_clip_ignore keeps its place between the two add_rects, with its bool, both directions");
  check(it->content_version == 4, "each call bumps content_version like any add");
  check(s.unsupported.empty(), "no item-level entry any more (D10: supported in /4)");

  m.set_omit_op("canvas_item_add_clip_ignore", 2);
  m.add_clip_ignore(100, true, 2);
  m.add_rect(100, kRect, kGreen, false, 2);
  const Snapshot s2 = m.snapshot(2, 2).state;
  check(item(s2, 1)->commands.size() == 5 &&
            item(s2, 1)->commands[4].kind == CommandKind::AddRect &&
            item(s2, 1)->content_version == 5,
        "omit-op canvas_item_add_clip_ignore drops the call: no command and no content_version bump");
  check(m.stats().dropped_omit_op == 1, "the drop is counted");

  m.set_omit_op("", 0);
  m.add_clip_ignore(999, true, 2);
  check(m.snapshot(2, 2).state.failures.size() == 1, "an unknown item fails like any other tap");
}

// G5d (gate5-design.md Q3b, render-stream-4.md "Command"): every immediate geometry tap records
// the call, argument for argument and every array whole, in call order, and the snapshot is
// stamped V4 so make_full carries the /4 blocks.
void test_geometry_taps() {
  using grc::rs2::AxisStretchMode;
  using grc::rs2::Point2;
  Mirror m;
  bind_root(&m);
  grc::rs::PayloadPtr bytes;
  const auto tex = rgba8_copy(4, 4, fill(4, 4, 7), &bytes);
  m.texture_2d_create(500, tex, bytes, 1);  // texture id 1
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.add_line(100, {8, 8.5f}, {136, 8.5f}, kRed, 1.0f, false, 1);
  m.add_polyline(100, {{8, 8}, {64, 8}, {64, 40}, {80, 40}}, {kRed, kGreen}, 4.0f, true, false, 1);
  m.add_polyline(100, {{0, 0}, {4, 0}, {8, 0}, {12, 0}}, {kGreen}, -1.0f, false, true, 1);
  m.add_circle(100, {32, 40}, 24.0f, kGreen, true, 1);
  m.add_primitive(100, {{8, 8}, {40, 8}, {8, 41}}, {kRed}, {}, 0, false, 1);
  m.add_primitive(100, {{0, 0}, {16, 0}, {16, 16}, {0, 16}}, {kGreen},
                  {{0, 0}, {1, 0}, {1, 1}, {0, 1}}, 500, true, 1);
  m.add_set_transform(100, {2, 0, 0, 2, 32, 0}, 1);
  m.add_triangle_array(100, {0, 1, 2, 0, 2, 3}, {{0, 0}, {8, 0}, {8, 8}, {0, 8}}, {kRed}, {}, false,
                       0, 1, 1);
  m.add_nine_patch(100, {8, 8, 56, 40}, {0, 0, 0, 0}, 500, {4, 4}, {4, 4}, 2, 1, false, kGreen, 1);
  m.add_set_transform(100, {1, 0, 0, 1, 0, 0}, 1);
  grc::rs::Captured c = m.snapshot(1, 1);
  const Snapshot &s = c.state;
  check(s.version == grc::rs2::ProtocolVersion::V6, "snapshots are stamped render-stream/6");
  const auto *it = item(s, 1);
  check(it != nullptr && it->commands.size() == 10 && it->content_version == 10,
        "ten taps, ten commands, ten content_version bumps");
  if (it == nullptr || it->commands.size() != 10) return;
  const auto &c0 = it->commands[0];
  check(c0.kind == CommandKind::AddLine && c0.line_from == Point2{8, 8.5f} &&
            c0.line_to == Point2{136, 8.5f} && c0.color == kRed && c0.width == 1.0f &&
            !c0.antialiased,
        "add_line: from, to, colour, width, aa as called");
  const auto &c1 = it->commands[1];
  check(c1.kind == CommandKind::AddPolyline && c1.points.size() == 4 && c1.colors.size() == 2 &&
            c1.width == 4.0f && c1.antialiased && c1.points[3] == Point2{80, 40},
        "add_polyline: every point and the hold-last colour list as given, never normalized");
  const auto &c2 = it->commands[2];
  check(c2.kind == CommandKind::AddMultiline && c2.points.size() == 4 && c2.colors.size() == 1 &&
            c2.width == -1.0f,
        "add_multiline: its own kind, width < 0 kept");
  const auto &c3 = it->commands[3];
  check(c3.kind == CommandKind::AddCircle && c3.circle_position == Point2{32, 40} &&
            c3.circle_radius == 24.0f && c3.antialiased,
        "add_circle: position, radius, colour, aa");
  const auto &c4 = it->commands[4];
  check(c4.kind == CommandKind::AddPrimitive && !c4.has_tex && c4.points.size() == 3 &&
            c4.uvs.empty(),
        "add_primitive with RID(): tex null (D11, no canvas texture this session)");
  const auto &c5 = it->commands[5];
  check(c5.kind == CommandKind::AddPolygon && c5.has_tex && c5.tex == 1 && c5.uvs.size() == 4,
        "add_polygon names its texture by wire id, UVs whole");
  check(it->commands[6].kind == CommandKind::AddSetTransform &&
            it->commands[6].transform == Xform{2, 0, 0, 2, 32, 0},
        "add_set_transform: the transform, in order (no mirror transform state)");
  const auto &c7 = it->commands[7];
  check(c7.kind == CommandKind::AddTriangleArray && c7.indices.size() == 6 &&
            c7.triangle_count == 1 && c7.points.size() == 4 && !c7.has_tex,
        "add_triangle_array: indices whole, count verbatim");
  const auto &c8 = it->commands[8];
  check(c8.kind == CommandKind::AddNinePatch && c8.tex == 1 && c8.x_axis == AxisStretchMode::TileFit &&
            c8.y_axis == AxisStretchMode::Tile && !c8.draw_center && c8.modulate == kGreen &&
            c8.np_margin_tl == Point2{4, 4} && c8.rect == Rect4{8, 8, 56, 40},
        "add_nine_patch: rect, source, margins, axis modes, draw_center, modulate");
  check(it->commands[9].transform == Xform{1, 0, 0, 1, 0, 0},
        "a reset to identity is its own command (replaced, not composed)");
  check(s.unsupported.empty(), "no item-level entry: every /4 op is a command");
  // The texture is named, so freeing it leaves a tombstone, as for the texture-rect ops.
  m.free_rid(500, 2);
  check(m.snapshot(2, 2).state.textures.size() == 1 &&
            m.snapshot(2, 2).state.textures[0].status == grc::rs2::TextureStatus::Freed,
        "a /4 op naming a freed texture keeps its tombstone");
  const grc::rs2::Transaction full = grc::rs2::make_full(s);
  check(full.version == grc::rs2::ProtocolVersion::V6, "make_full carries the V6 stamp");

  // Skinned triangle arrays and out-of-range axis modes are typed refusals.
  Mirror k;
  bind_root(&k);
  k.canvas_item_create(100, 1);
  k.set_parent(100, kRootCanvas, 1);
  k.add_triangle_array(100, {}, {}, {}, {}, true, 0, -1, 1);
  k.add_nine_patch(100, kRect, kRect, 0, {1, 1}, {1, 1}, 3, 0, true, kRed, 1);
  const Snapshot ks = k.snapshot(1, 1).state;
  check(item(ks, 1)->commands[0].kind == CommandKind::Unsupported &&
            item(ks, 1)->commands[0].unsupported_reason ==
                grc::rs2::UnsupportedCmdReason::SkinnedGeometry,
        "bones or weights: unsupported skinned-geometry (D16)");
  check(item_entries(ks) ==
            std::vector<Entry>{
                {1, "canvas_item_add_nine_patch", UnsupportedReason::UnsupportedOp},
                {1, "canvas_item_add_triangle_array", UnsupportedReason::SkinnedGeometry}},
        "their item-level entries, sorted by op");
}

// D11: RID() is `tex: null` until a headless host has created a canvas texture; from then on the
// /4 ops naming RID() are canvas-texture-headless refusals (sticky), while a rendered host keeps
// writing null. An unknown non-null RID is unknown-texture.
void test_geometry_texture_ambiguity() {
  Mirror h;
  bind_root(&h);
  h.set_canvas_texture_headless(true);
  h.canvas_item_create(100, 1);
  h.set_parent(100, kRootCanvas, 1);
  h.add_primitive(100, {{0, 0}, {4, 0}, {0, 4}}, {kRed}, {}, 0, true, 1);
  check(item(h.snapshot(1, 1).state, 1)->commands[0].kind == CommandKind::AddPolygon &&
            !item(h.snapshot(1, 1).state, 1)->commands[0].has_tex,
        "headless, no canvas texture yet: RID() is tex null");
  h.canvas_texture_create(0, 2);  // the dummy storage hands back RID()
  h.add_primitive(100, {{0, 0}, {4, 0}, {0, 4}}, {kRed}, {}, 0, true, 2);
  h.add_nine_patch(100, kRect, kRect, 0, {1, 1}, {1, 1}, 0, 0, true, kRed, 2);
  h.add_line(100, {0, 0}, {4, 4}, kRed, 1.0f, false, 2);  // no texture argument: unaffected
  h.add_triangle_array(100, {0, 1, 2}, {{0, 0}, {4, 0}, {0, 4}}, {}, {}, false, 777, -1, 2);
  const Snapshot s = h.snapshot(2, 2).state;
  const auto &cmds = item(s, 1)->commands;
  check(cmds.size() == 5 && cmds[1].kind == CommandKind::Unsupported &&
            cmds[1].unsupported_reason == grc::rs2::UnsupportedCmdReason::CanvasTextureHeadless &&
            cmds[1].name == "canvas_item_add_polygon" &&
            cmds[2].unsupported_reason == grc::rs2::UnsupportedCmdReason::CanvasTextureHeadless &&
            cmds[2].name == "canvas_item_add_nine_patch",
        "after a headless canvas_texture_create, RID() on a /4 op is canvas-texture-headless");
  check(cmds.size() == 5 && cmds[0].kind == CommandKind::AddPolygon,
        "a command recorded before the canvas texture existed keeps tex null");
  check(cmds.size() == 5 && cmds[3].kind == CommandKind::AddLine,
        "ops without a texture argument are never ambiguous");
  check(cmds.size() == 5 && cmds[4].kind == CommandKind::Unsupported &&
            cmds[4].unsupported_reason == grc::rs2::UnsupportedCmdReason::UnknownTexture,
        "an unknown non-null RID is unknown-texture");
  check(item_entries(s) ==
            std::vector<Entry>{
                {1, "canvas_item_add_nine_patch", UnsupportedReason::CanvasTextureHeadless},
                {1, "canvas_item_add_polygon", UnsupportedReason::CanvasTextureHeadless},
                {1, "canvas_item_add_triangle_array", UnsupportedReason::UnknownTexture}},
        "item-level entries for the refused draws");
  h.reset();
  h.set_root(kRootViewport, kRootCanvas, kRootXform);
  h.set_canvas_texture_headless(true);
  h.canvas_item_create(100, 1);
  h.set_parent(100, kRootCanvas, 1);
  h.add_primitive(100, {{0, 0}, {4, 0}, {0, 4}}, {kRed}, {}, 0, false, 1);
  check(item(h.snapshot(1, 1).state, 1)->commands[0].kind == CommandKind::AddPrimitive,
        "reset() clears the canvas-texture-created flag");

  // The opt-in headless shim (canvas-texture-headless.md "Experiment (a) result"): the create
  // carries a private, non-null RID, so RID() stays unambiguous on a headless host and the
  // canvas texture itself is drawable.
  Mirror sh;
  bind_root(&sh);
  sh.set_canvas_texture_headless(true);
  const std::uint64_t kPrivate = (0x47524354ull << 32) | 0x80000000ull;
  sh.canvas_texture_create(kPrivate, 1);
  sh.canvas_item_create(100, 1);
  sh.set_parent(100, kRootCanvas, 1);
  sh.add_primitive(100, {{0, 0}, {4, 0}, {0, 4}}, {kRed}, {}, 0, true, 1);
  sh.add_primitive(100, {{0, 0}, {4, 0}, {0, 4}}, {kRed}, {}, kPrivate, true, 1);
  const Snapshot ss = sh.snapshot(1, 1).state;
  const auto &sc = item(ss, 1)->commands;
  check(sc.size() == 2 && sc[0].kind == CommandKind::AddPolygon && !sc[0].has_tex,
        "headless with a shim RID canvas texture: RID() is still tex null");
  check(sc.size() == 2 && sc[1].kind == CommandKind::AddPolygon && sc[1].has_tex,
        "headless with a shim RID canvas texture: the canvas texture itself is drawable");
  check(item_entries(ss).empty(), "headless with a shim RID canvas texture: nothing refused");

  Mirror r;  // a rendered host: never headless, so RID() always means no texture
  bind_root(&r);
  r.canvas_texture_create(900, 1);
  r.canvas_item_create(100, 1);
  r.set_parent(100, kRootCanvas, 1);
  r.add_primitive(100, {{0, 0}, {4, 0}, {0, 4}}, {kRed}, {}, 0, true, 1);
  check(item(r.snapshot(1, 1).state, 1)->commands[0].kind == CommandKind::AddPolygon &&
            !item(r.snapshot(1, 1).state, 1)->commands[0].has_tex,
        "rendered host with a canvas texture: RID() is still tex null");
}

// perturb-vertex (gate5-design.md Q3c): from its frame on, the first point's x of every
// line/polyline/multiline/primitive/polygon/triangle-array command gains +1.0; earlier commands,
// circles and other points never move.
void test_perturb_vertex() {
  using grc::rs2::Point2;
  Mirror m;
  bind_root(&m);
  m.set_perturb_vertex(21);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.add_line(100, {8, 8}, {16, 8}, kRed, 2.0f, false, 20);
  m.add_line(100, {8, 8}, {16, 8}, kRed, 2.0f, false, 21);
  m.add_polyline(100, {{1, 1}, {2, 2}}, {kRed}, 1.0f, false, false, 21);
  m.add_polyline(100, {{1, 1}, {2, 2}}, {kRed}, 1.0f, false, true, 21);
  m.add_primitive(100, {{1, 1}, {2, 2}, {3, 1}}, {kRed}, {}, 0, false, 21);
  m.add_primitive(100, {{1, 1}, {2, 2}, {3, 1}}, {kRed}, {}, 0, true, 21);
  m.add_triangle_array(100, {0, 1, 2}, {{1, 1}, {2, 2}, {3, 1}}, {}, {}, false, 0, -1, 21);
  m.add_circle(100, {5, 5}, 3.0f, kRed, false, 21);
  const Snapshot snap = m.snapshot(1, 21).state;
  const auto &cmds = item(snap, 1)->commands;
  check(cmds[0].line_from == Point2{8, 8}, "before the sabotage frame nothing moves");
  check(cmds[1].line_from == Point2{9, 8} && cmds[1].line_to == Point2{16, 8},
        "add_line: from.x + 1, to unchanged");
  bool all = true;
  for (int i = 2; i <= 6; ++i) {
    all = all && cmds[i].points[0] == Point2{2, 1} && cmds[i].points[1] == Point2{2, 2};
  }
  check(all, "polyline, multiline, primitive, polygon, triangle array: points[0].x + 1 only");
  check(cmds[7].circle_position == Point2{5, 5}, "add_circle is outside perturb-vertex's scope");
}

// gate4-design.md Q3 "MSDF tap" (G4e2), render-stream-3.md "Command": the msdf draw is a /3
// command with its outline, px_range and scale, follows add_texture_rect_region's texture rules,
// honours omit-op and treats an unknown item as pre-existing-object.
void test_msdf_command_with_outline() {
  Mirror m;
  bind_root(&m);
  grc::rs::PayloadPtr page_bytes;
  const auto page = rgba8_copy(8, 8, fill(8, 8, 0), &page_bytes);
  m.texture_2d_create(500, page, page_bytes, 1);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  const Rect4 rect = {3.5f, -12.25f, 10.75f, 14.0f};
  const Rect4 flipped = {20.0f, 0.0f, -6.0f, 9.0f};
  const Rect4 src = {1, 1, 15, 20};
  const Color4 colour = {1, 0.8f, 0.2f, 1};
  m.add_msdf_texture_rect_region(100, rect, 500, src, colour, 0, 24.0f, 0.5f, 1);
  m.add_msdf_texture_rect_region(100, flipped, 500, src, kGreen, 4, 24.0f, 0.5f, 1);
  const grc::rs::Captured c = m.snapshot(1, 1);
  const auto *it = item(c.state, 1);
  check(it != nullptr && it->commands.size() == 2 && it->content_version == 2,
        "two msdf commands, each bumps content_version");
  if (it == nullptr || it->commands.size() != 2) return;
  const auto &a = it->commands[0];
  const auto &b = it->commands[1];
  check(a.kind == CommandKind::AddMsdfTextureRectRegion && a.has_tex && a.tex == 1 &&
            a.rect == rect && a.src == src && a.modulate == colour && a.msdf_outline == 0 &&
            a.msdf_px_range == 24.0f && a.msdf_scale == 0.5f,
        "the fill pass carries the engine's arguments exactly (outline 0)");
  check(b.kind == CommandKind::AddMsdfTextureRectRegion && b.rect == flipped &&
            b.msdf_outline == 4 && b.modulate == kGreen,
        "the outline pass keeps outline 4 and a negative width as given");
  check(c.state.unsupported.empty(), "a supported msdf command derives no unsupported entry");
  check(c.payloads.count(page.hash) == 1, "the page's payload is published");
  // The page stays referenced by the msdf command alone: freeing it leaves a tombstone.
  m.free_rid(500, 2);
  const Snapshot s2 = m.snapshot(2, 2).state;
  check(texture(s2, 1) != nullptr && texture(s2, 1)->status == grc::rs2::TextureStatus::Freed,
        "a freed page an msdf command names stays as a freed tombstone");
}

void test_msdf_unknown_texture() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.add_msdf_texture_rect_region(100, kRect, 0xdead, kRect, kRed, 0, 24.0f, 1.0f, 1);
  const Snapshot s = m.snapshot(1, 1).state;
  const auto *it = item(s, 1);
  check(it != nullptr && it->commands.size() == 1 &&
            it->commands[0].kind == CommandKind::Unsupported &&
            it->commands[0].name == "canvas_item_add_msdf_texture_rect_region" &&
            it->commands[0].unsupported_reason == grc::rs2::UnsupportedCmdReason::UnknownTexture,
        "an msdf command naming a RID never created is unsupported/unknown-texture in place");
  check(item_entries(s) == std::vector<Entry>{{1, "canvas_item_add_msdf_texture_rect_region",
                                               UnsupportedReason::UnknownTexture}},
        "with its derived item-level unknown-texture entry");
  // An unsupported page (refused format) gives the derived unsupported-texture entry.
  grc::rs::PayloadCopy refused;
  refused.status = "unsupported";
  refused.reason = "unsupported-format";
  refused.format = 11;
  refused.width = 4;
  refused.height = 4;
  refused.mipmaps_known = true;
  m.texture_2d_create(600, refused, nullptr, 2);
  m.clear(100, 2);
  m.add_msdf_texture_rect_region(100, kRect, 600, kRect, kRed, 0, 24.0f, 1.0f, 2);
  check(item_entries(m.snapshot(2, 2).state) ==
            std::vector<Entry>{{1, "canvas_item_add_msdf_texture_rect_region",
                                UnsupportedReason::UnsupportedTexture}},
        "an msdf command naming an unsupported entry derives unsupported-texture");
  // An unknown item is pre-existing-object, as for every other tap.
  m.add_msdf_texture_rect_region(999, kRect, 600, kRect, kRed, 0, 24.0f, 1.0f, 2);
  check(has_failure(m.snapshot(3, 2).state, FailureReason::PreExistingObject),
        "an msdf draw on an unknown item is pre-existing-object");
}

void test_msdf_omit_op() {
  Mirror m;
  bind_root(&m);
  grc::rs::PayloadPtr page_bytes;
  const auto page = rgba8_copy(8, 8, fill(8, 8, 0), &page_bytes);
  m.texture_2d_create(500, page, page_bytes, 1);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.set_omit_op("canvas_item_add_msdf_texture_rect_region", 2);
  m.add_msdf_texture_rect_region(100, kRect, 500, kRect, kRed, 0, 24.0f, 1.0f, 1);
  const uint64_t e = m.epoch();
  m.add_msdf_texture_rect_region(100, kRect, 500, kRect, kRed, 0, 24.0f, 1.0f, 2);
  const Snapshot s = m.snapshot(1, 2).state;
  check(item(s, 1)->commands.size() == 1 && item(s, 1)->content_version == 1 && m.epoch() == e,
        "omit-op drops the msdf draw from its frame on: no command, no bump, no epoch");
  check(m.stats().dropped_omit_op == 1, "the dropped msdf draw is counted");
}

// gate4-design.md Q3 "perturb-glyph": from the sabotage frame on, the mirror records rect.x +
// 0.25 for both glyph commands, nothing else.
void test_perturb_glyph() {
  Mirror m;
  bind_root(&m);
  grc::rs::PayloadPtr page_bytes;
  const auto page = rgba8_copy(8, 8, fill(8, 8, 0), &page_bytes);
  m.texture_2d_create(500, page, page_bytes, 1);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.set_perturb_glyph(3);
  const Rect4 rect = {10, 20, 8, 9};
  const Rect4 src = {1, 2, 8, 9};
  m.add_texture_rect_region(100, rect, 500, src, kRed, false, false, 2);
  m.add_msdf_texture_rect_region(100, rect, 500, src, kRed, 0, 24.0f, 1.0f, 2);
  m.add_texture_rect_region(100, rect, 500, src, kRed, false, false, 3);
  m.add_msdf_texture_rect_region(100, rect, 500, src, kRed, 4, 24.0f, 1.0f, 3);
  m.add_texture_rect(100, rect, 500, false, kRed, false, 3);
  m.add_rect(100, rect, kRed, false, 3);
  const Snapshot s = m.snapshot(1, 3).state;
  const auto &c = item(s, 1)->commands;
  const Rect4 moved = {10.25f, 20, 8, 9};
  check(c.size() == 6 && c[0].rect == rect && c[1].rect == rect,
        "before the sabotage frame both glyph commands are recorded as given");
  check(c.size() == 6 && c[2].rect == moved && c[3].rect == moved && c[2].src == src &&
            c[3].src == src && c[3].msdf_outline == 4,
        "from the sabotage frame rect.x gains 0.25 on region and msdf commands, src untouched");
  check(c.size() == 6 && c[4].rect == rect && c[5].rect == rect,
        "add_texture_rect and add_rect are not glyph commands and stay as given");
  m.reset();
  m.set_root(kRootViewport, kRootCanvas, kRootXform);
  m.texture_2d_create(500, page, page_bytes, 1);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.add_texture_rect_region(100, rect, 500, src, kRed, false, false, 9);
  check(item(m.snapshot(1, 9).state, 1)->commands[0].rect == rect, "reset() turns it off");
}

// gate5-design.md D2, D16, calibrator 7: canvas_item_attach_skeleton with a non-null skeleton is
// reported in Snapshot::unsupported only, exactly like a non-null material (set_material), under
// its own op name, and never bumps content_version. attach_skeleton(RID()) (the spike's and
// Polygon2D's per-draw call) is free: it clears the flag again when already clear.
void test_attach_skeleton_tap() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.add_rect(100, kRect, kGreen, false, 1);
  m.attach_skeleton(100, 0, 1);  // RID(): free, no state change
  Snapshot s = m.snapshot(1, 1).state;
  check(!has_skeleton_entry(s, 1), "a null skeleton gives no unsupported-state entry");
  check(item(s, 1)->content_version == 1, "attach_skeleton never bumps content_version");

  m.attach_skeleton(100, 0x55, 2);
  s = m.snapshot(2, 2).state;
  check(has_skeleton_entry(s, 1), "a non-null skeleton gives an unsupported-state entry");
  check(item(s, 1)->content_version == 1, "still no content_version bump");
  check(s.unsupported.size() == 1 && s.unsupported[0].op == "canvas_item_attach_skeleton" &&
            s.unsupported[0].reason == UnsupportedReason::UnsupportedState,
        "one item-level entry, reason unsupported-state");

  m.attach_skeleton(100, 0, 3);
  s = m.snapshot(3, 3).state;
  check(!has_skeleton_entry(s, 1), "a null skeleton clears the unsupported-state entry");

  // An unknown item is the same pre-existing-object failure every other tap gives.
  m.attach_skeleton(999, 0x55, 3);
  check(m.snapshot(3, 3).state.failures.size() == 1, "an unknown item fails like any other tap");
}

// --- meshes (G5e; gate5-design.md D5-D8, Q3b, Q3c; render-stream-4.md "Mesh table") ---------

// A GRM1 surface the way a mesh hook hands it to the mirror: `n` 2D vertices whose first x is
// `x0`, triangles, no colour/UV/index, an AABB at (x0, 0).
grc::rs::MeshSurfaceInput mesh_input(float x0, uint32_t n = 3) {
  std::vector<uint8_t> vertices(8 * n, 0);
  for (uint32_t i = 0; i < n; ++i) {
    const float xy[2] = {x0 + static_cast<float>(i), static_cast<float>(i % 2)};
    std::memcpy(vertices.data() + 8 * i, xy, sizeof(xy));
  }
  const uint64_t format = grc::rs::kArrayFormatVertex | grc::rs::kArrayFlagUse2dVertices;
  const grc::AABB aabb = {{x0, 0, 0}, {static_cast<float>(n), 1, 0}};
  const grc::Vector4 uv = {0, 0, 0, 0};
  grc::rs::MeshSurfaceInput input;
  auto payload = std::make_shared<grc::rs::PayloadBytes>(grc::rs::encode_payload(
      3, format, n, 0, aabb, uv, vertices.data(), vertices.size(), nullptr, 0, nullptr, 0,
      nullptr, 0));
  input.copy.status = "ok";
  input.copy.primitive = 3;
  input.copy.format = format;
  input.copy.vertex_count = n;
  input.copy.index_count = 0;
  input.copy.hash = grc::sha256_hex(payload->data(), payload->size());
  input.bytes = std::move(payload);
  return input;
}

// HC3: a region write that turns a surface's payload into `to`'s (same size): the whole payload,
// from byte 0 -- the mirror writes any region the hook names. The pointer is valid until the next
// call (each test passes it straight to mesh_surface_update_region).
const grc::rs::MeshRegionWrite *whole(const grc::rs::MeshSurfaceInput &to) {
  static grc::rs::MeshRegionWrite write;
  write.offset = 0;
  write.data = to.bytes->data();
  write.size = to.bytes->size();
  return &write;
}

grc::rs::MeshSurfaceInput refused_input(const char *reason) {
  grc::rs::MeshSurfaceInput input;
  input.copy.status = "unsupported";
  input.copy.reason = reason;
  input.copy.primitive = 3;
  input.copy.format = grc::rs::kArrayFormatVertex | grc::rs::kArrayFlagCompressAttributes;
  input.copy.vertex_count = 3;
  input.copy.index_count = 0;
  return input;
}

const grc::rs2::MeshEntry *mesh(const Snapshot &s, uint32_t id) {
  for (const auto &m : s.meshes) {
    if (m.id == id) return &m;
  }
  return nullptr;
}

bool has_entry(const Snapshot &s, uint32_t item_id, const std::string &op,
               UnsupportedReason reason) {
  for (const auto &u : s.unsupported) {
    if (u.has_item && u.item == item_id && u.op == op && u.reason == reason) return true;
  }
  return false;
}

// Ids, versions (+1 per accepted call, the hook log's counting), whole-surface payloads, the
// custom AABB, removal renumbering and clear; the snapshot pins every ok surface's payload.
void test_mesh_table_lifecycle() {
  using grc::rs2::MeshStatus;
  Mirror m;
  bind_root(&m);
  const auto a = mesh_input(0);
  const auto b = mesh_input(10, 4);
  m.mesh_create(0x500, 1);
  m.mesh_add_surface(0x500, a, 1);
  m.mesh_add_surface(0x500, b, 1);
  m.mesh_create_from_surfaces(0x600, {mesh_input(20)}, 1);
  grc::rs::Captured cap = m.snapshot(1, 1);
  const auto *m1 = mesh(cap.state, 1);
  const auto *m2 = mesh(cap.state, 2);
  check(cap.state.meshes.size() == 2 && m1 != nullptr && m2 != nullptr,
        "two meshes, ids 1 and 2 in creation order (their own counter)");
  check(m1 != nullptr && m1->version == 3 && m1->status == MeshStatus::Ok &&
            m1->surfaces.size() == 2 && m1->surfaces[0].hash == a.copy.hash &&
            m1->surfaces[1].hash == b.copy.hash &&
            m1->surfaces[0].payload_bytes == a.bytes->size() && m1->has_aabb &&
            m1->surfaces[1].vertex_count == 4 &&
            m1->surfaces[0].primitive == grc::rs2::Primitive::Triangles,
        "create + two adds: version 3, both surfaces with hash, whole-payload bytes, counts");
  check(m2 != nullptr && m2->version == 1 && m2->surfaces.size() == 1,
        "create_from_surfaces: version 1 with its surface");
  check(cap.payloads.size() == 3 && cap.payloads.count(a.copy.hash) == 1 &&
            cap.payloads.at(a.copy.hash).get() == a.bytes.get(),
        "the snapshot pins every ok surface's payload, shared, never copied");

  // DF's spine pattern: three accepted calls in one frame give one snapshot, version + 3.
  const auto a2 = mesh_input(1);
  m.mesh_surface_update_region(0x500, "mesh_surface_update_vertex_region", 0, true, whole(a2), 2);
  m.mesh_surface_update_region(0x500, "mesh_surface_update_attribute_region", 0, true, whole(a2), 2);
  m.mesh_set_custom_aabb(0x500, {0, -2, 0, 128, 68, 0}, 2);
  m.mesh_surface_update_region(0x500, "mesh_surface_update_vertex_region", 5, false, nullptr, 2);
  m.mesh_surface_update_region(0x999, "mesh_surface_update_vertex_region", 0, true, whole(a2), 2);
  cap = m.snapshot(2, 2);
  m1 = mesh(cap.state, 1);
  check(m1 != nullptr && m1->version == 6 && m1->surfaces[0].hash == a2.copy.hash &&
            m1->custom_aabb[1] == -2.0f && m1->custom_aabb[4] == 68.0f,
        "two applied region updates and a custom AABB: version 6, the new surface payload, the AABB");
  check(cap.payloads.count(a.copy.hash) == 0 && cap.payloads.count(a2.copy.hash) == 1,
        "the superseded surface payload is no longer pinned");
  check(m.stats().mesh_unknown == 1, "an update of an unknown mesh RID is counted, changes nothing");

  m.mesh_surface_remove(0x500, 0, 3);
  m.mesh_surface_remove(0x500, 7, 3);
  cap = m.snapshot(3, 3);
  m1 = mesh(cap.state, 1);
  check(m1 != nullptr && m1->version == 7 && m1->surfaces.size() == 1 &&
            m1->surfaces[0].hash == b.copy.hash,
        "remove(0): surface 1 renumbers to 0, version + 1; an out-of-range remove changes nothing");
  m.mesh_clear(0x500, 4);
  cap = m.snapshot(4, 4);
  m1 = mesh(cap.state, 1);
  check(m1 != nullptr && m1->version == 8 && m1->surfaces.empty() &&
            m1->status == MeshStatus::Ok && m1->custom_aabb[4] == 68.0f,
        "clear: no surfaces, ok, version + 1, the custom AABB kept");
  check(m.stats().live_meshes == 2, "stats: two live meshes");
}

// A mesh an add_mesh names becomes a `freed` tombstone (f null, surfaces []), which leaves the
// table at the first snapshot nothing names it; an unnamed one leaves at once; the add_mesh
// command carries the mesh id, transform, modulate and texture (D11).
void test_mesh_add_mesh_and_tombstones() {
  using grc::rs2::MeshStatus;
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.mesh_create(0x500, 1);
  m.mesh_add_surface(0x500, mesh_input(0), 1);
  m.mesh_create(0x600, 1);
  m.add_mesh(100, 0x500, {1, 0, 0, 1, 4, 5}, kRed, 0, 1);
  grc::rs::Captured cap = m.snapshot(1, 1);
  const auto &cmds = item(cap.state, 1)->commands;
  check(cmds.size() == 1 && cmds[0].kind == CommandKind::AddMesh && cmds[0].mesh == 1 &&
            !cmds[0].has_tex && cmds[0].transform[4] == 4.0f && cmds[0].modulate == kRed,
        "add_mesh: mesh id 1, tex null for RID(), transform and modulate as given");
  m.free_rid(0x600, 2);
  m.free_rid(0x500, 2);
  cap = m.snapshot(2, 2);
  const auto *m1 = mesh(cap.state, 1);
  check(m1 != nullptr && m1->status == MeshStatus::Freed && !m1->has_aabb &&
            m1->surfaces.empty() && m1->version == 2 && mesh(cap.state, 2) == nullptr,
        "free of a named mesh: a freed tombstone, version unchanged; an unnamed one leaves");
  check(cap.payloads.empty(), "a tombstone pins no payload");
  // Recreation in one frame (DF's step 5): free, create, clear, add_mesh of the new id.
  m.mesh_create(0x500, 3);  // the recycled RID value is a new id
  m.mesh_add_surface(0x500, mesh_input(3), 3);
  m.clear(100, 3);
  m.add_mesh(100, 0x500, {1, 0, 0, 1, 0, 0}, kGreen, 0, 3);
  cap = m.snapshot(3, 3);
  check(mesh(cap.state, 1) == nullptr && mesh(cap.state, 3) != nullptr &&
            item(cap.state, 1)->commands[0].mesh == 3,
        "recreation: the new id arrives and the old tombstone leaves in the same snapshot");
  // The patch between them carries the mesh change: removed 1, entry 3.
  const grc::rs2::Transaction patch = grc::rs2::make_patch(m.snapshot(2, 2).state, cap.state);
  check(patch.version == grc::rs2::ProtocolVersion::V6, "snapshots are V6");
  m.free_rid(0x500, 4);
  m.mesh_set_custom_aabb(0x500, {1, 1, 0, 1, 1, 0}, 4);
  cap = m.snapshot(4, 4);
  check(mesh(cap.state, 3) != nullptr && mesh(cap.state, 3)->status == MeshStatus::Freed &&
            mesh(cap.state, 3)->version == 2,
        "a tap on a freed mesh RID changes nothing");
  m.clear(100, 5);
  cap = m.snapshot(5, 5);
  check(cap.state.meshes.empty(), "once no command names it the tombstone leaves the table");
}

// D7/D15: a refused surface makes the entry `unsupported` (surfaces []); an add_mesh naming it
// derives `unsupported-mesh`; an unknown mesh RID is an `unknown-mesh` command; clear makes the
// entry ok again.
void test_mesh_unsupported_and_unknown() {
  using grc::rs2::MeshStatus;
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.mesh_create(0x500, 1);
  m.mesh_add_surface(0x500, mesh_input(0), 1);
  m.mesh_add_surface(0x500, refused_input("mesh-format"), 1);
  m.add_mesh(100, 0x500, {1, 0, 0, 1, 0, 0}, kRed, 0, 1);
  m.add_mesh(100, 0x777, {1, 0, 0, 1, 0, 0}, kRed, 0, 1);
  grc::rs::Captured cap = m.snapshot(1, 1);
  const auto *m1 = mesh(cap.state, 1);
  check(m1 != nullptr && m1->status == MeshStatus::Unsupported && m1->has_reason &&
            m1->reason == grc::rs2::MeshReason::MeshFormat && m1->surfaces.empty() &&
            m1->has_aabb,
        "a refused surface: unsupported, mesh-format, surfaces [], f present");
  check(cap.payloads.empty(), "an unsupported mesh pins nothing");
  const auto &cmds = item(cap.state, 1)->commands;
  check(cmds.size() == 2 && cmds[0].kind == CommandKind::AddMesh &&
            cmds[1].kind == CommandKind::Unsupported &&
            cmds[1].unsupported_reason == grc::rs2::UnsupportedCmdReason::UnknownMesh &&
            cmds[1].name == "canvas_item_add_mesh",
        "an unknown mesh RID: an unsupported unknown-mesh command in place");
  check(has_entry(cap.state, 1, "canvas_item_add_mesh", UnsupportedReason::UnsupportedMesh) &&
            has_entry(cap.state, 1, "canvas_item_add_mesh", UnsupportedReason::UnknownMesh),
        "item-level unsupported-mesh and unknown-mesh entries");
  // A region update on the refused surface: version + 1 only.
  m.mesh_surface_update_region(0x500, "mesh_surface_update_vertex_region", 1, true, nullptr, 2);
  check(mesh(m.snapshot(2, 2).state, 1)->version == 4, "an update of a refused surface: v + 1");
  m.mesh_surface_remove(0x500, 1, 3);
  cap = m.snapshot(3, 3);
  check(mesh(cap.state, 1)->status == MeshStatus::Ok && mesh(cap.state, 1)->surfaces.size() == 1 &&
            !has_entry(cap.state, 1, "canvas_item_add_mesh", UnsupportedReason::UnsupportedMesh),
        "once its refused surface is removed the entry is ok again");
}

// omit-op on a mesh tap drops it (no version), as the hook log does; perturb-vertex moves the
// first vertex x of every payload taken from its frame on (Q3c), re-hashed, never the engine's.
void test_mesh_omit_op_and_perturb_vertex() {
  Mirror m;
  bind_root(&m);
  m.set_omit_op("mesh_surface_update_vertex_region", 21);
  m.mesh_create(0x500, 1);
  m.mesh_add_surface(0x500, mesh_input(0), 1);
  const auto b = mesh_input(5);
  m.mesh_surface_update_region(0x500, "mesh_surface_update_vertex_region", 0, true, whole(b), 21);
  grc::rs::Captured cap = m.snapshot(1, 21);
  check(mesh(cap.state, 1)->version == 2 && mesh(cap.state, 1)->surfaces[0].hash != b.copy.hash,
        "omit-op: the omitted region update changes nothing");
  m.mesh_surface_update_region(0x500, "mesh_surface_update_attribute_region", 0, true, whole(b), 21);
  check(mesh(m.snapshot(2, 21).state, 1)->surfaces[0].hash == b.copy.hash,
        "another op still applies");

  Mirror p;
  bind_root(&p);
  p.set_perturb_vertex(21);
  const auto early = mesh_input(0);
  const auto late = mesh_input(7);
  p.mesh_create(0x500, 1);
  p.mesh_add_surface(0x500, early, 20);
  p.mesh_create(0x600, 1);
  p.mesh_add_surface(0x600, late, 21);
  cap = p.snapshot(1, 21);
  const auto &s1 = mesh(cap.state, 1)->surfaces[0];
  const auto &s2 = mesh(cap.state, 2)->surfaces[0];
  check(s1.hash == early.copy.hash, "a payload taken before the sabotage frame is untouched");
  bool moved = false;
  if (s2.hash != late.copy.hash && cap.payloads.count(s2.hash) == 1) {
    const grc::rs::PayloadBytes &bytes = *cap.payloads.at(s2.hash);
    const grc::rs::PayloadBytes &truth = *late.bytes;
    const uint32_t meta_len = static_cast<uint32_t>(truth[8]) | (truth[9] << 8);
    const size_t off = 12 + meta_len + 40;
    float x = 0;
    float y = 0;
    std::memcpy(&x, bytes.data() + off, 4);
    std::memcpy(&y, bytes.data() + off + 4, 4);
    moved = x == 8.0f && y == 0.0f && bytes.size() == truth.size() &&
            grc::sha256_hex(bytes.data(), bytes.size()) == s2.hash;
    for (size_t i = 0; i < truth.size(); ++i) {
      if ((i < off || i >= off + 4) && bytes[i] != truth[i]) moved = false;
    }
  }
  check(moved, "perturb-vertex: only the first vertex x moves, +1.0, and the hash is the copy's");
  check(*late.bytes == *mesh_input(7).bytes, "the hook's own payload is not modified");
}

// --- unknown items under Skip (protocol/unknown-item-skip.md) ------------------------------------

constexpr uint64_t kUnknownItem = 0xABC;    // an item created before arming
constexpr uint64_t kUnknownParent = 0x777;  // an unknown parent (an item or a canvas)

void skip_root(Mirror *mirror) {
  bind_root(mirror);
  mirror->set_unknown_item_policy(grc::rs2::UnknownItemPolicy::Skip);
}

std::vector<uint32_t> item_ids(const Snapshot &s) {
  std::vector<uint32_t> out;
  for (const auto &it : s.items) out.push_back(it.id);
  return out;
}

bool unknown_counts(const Snapshot &s, uint64_t rids, uint64_t withheld, uint64_t commands,
                    uint64_t calls) {
  const grc::rs2::UnknownItems &u = s.unknown_items;
  return u.present && u.unknown_rids == rids && u.withheld_items == withheld &&
         u.withheld_commands == commands && u.unknown_calls == calls;
}

// The state the wire carries, compared field by field (what resolve() must reproduce).
bool same_state(const Snapshot &a, const Snapshot &b) {
  if (a.canvases.size() != b.canvases.size() || a.items.size() != b.items.size()) return false;
  for (std::size_t i = 0; i < a.canvases.size(); ++i) {
    if (a.canvases[i].id != b.canvases[i].id || a.canvases[i].items != b.canvases[i].items)
      return false;
  }
  for (std::size_t i = 0; i < a.items.size(); ++i) {
    const auto &x = a.items[i];
    const auto &y = b.items[i];
    if (x.id != y.id || x.parent.kind != y.parent.kind || x.parent.id != y.parent.id ||
        x.children != y.children || x.content_version != y.content_version ||
        x.commands.size() != y.commands.size() || x.xform != y.xform || x.visible != y.visible ||
        x.draw_index != y.draw_index)
      return false;
  }
  const grc::rs2::UnknownItems &u = a.unknown_items;
  const grc::rs2::UnknownItems &v = b.unknown_items;
  return a.unsupported.size() == b.unsupported.size() && a.failures.size() == b.failures.size() &&
         u.present == v.present && u.unknown_rids == v.unknown_rids &&
         u.withheld_items == v.withheld_items && u.withheld_commands == v.withheld_commands &&
         u.unknown_calls == v.unknown_calls;
}

void test_skip_strict_default_unchanged() {
  Mirror m;
  bind_root(&m);
  m.set_parent(kUnknownItem, kRootCanvas, 1);
  Snapshot s = m.snapshot(1, 1).state;
  check(!s.unknown_items.present, "strict: no unknown_items account");
  check(has_failure(s, FailureReason::PreExistingObject), "strict: still pre-existing-object");
  // reset() restores Strict.
  Mirror n;
  skip_root(&n);
  bind_root(&n);
  n.set_parent(kUnknownItem, kRootCanvas, 1);
  s = n.snapshot(1, 1).state;
  check(!s.unknown_items.present && has_failure(s, FailureReason::PreExistingObject),
        "reset() returns to strict");
}

void test_skip_unknown_target() {
  Mirror m;
  skip_root(&m);
  m.canvas_item_create(100, 1);  // item 1
  m.set_parent(100, kRootCanvas, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  Snapshot s = m.snapshot(1, 1).state;
  check(unknown_counts(s, 0, 0, 0, 0), "skip: a clean session carries zeros");
  check(s.status() == grc::rs2::TransactionStatus::Ok, "skip: clean status ok");

  // A pre-existing item enters the tree and draws: every call is counted, none applied.
  m.set_parent(kUnknownItem, kRootCanvas, 2);
  m.set_visibility_layer(kUnknownItem, 1, 2);
  m.clear(kUnknownItem, 2);
  m.add_rect(kUnknownItem, kRect, kGreen, false, 2);
  m.set_transform(kUnknownItem, kRootXform, 3);
  s = m.snapshot(2, 3).state;
  check(s.failures.empty() && s.status() == grc::rs2::TransactionStatus::Ok,
        "skip: an unknown item is not a capture failure");
  check(unknown_counts(s, 1, 0, 0, 5), "skip: one unknown RID, five calls");
  check(item_ids(s) == std::vector<uint32_t>{1} && canvas(s, 1)->items == ids({1}),
        "skip: the known item is untouched");
  check(m.stats().unknown_rids_named == 1 && m.stats().unknown_calls == 5, "skip: stats");

  // An unknown canvas on the root viewport is counted too.
  m.viewport_set_canvas_transform(kRootViewport, 0x5555, kRootXform, 4);
  m.viewport_attach_canvas(kRootViewport, 0x5555, 4);
  s = m.snapshot(3, 4).state;
  check(s.failures.empty() && unknown_counts(s, 2, 0, 0, 7),
        "skip: an unknown canvas on the root viewport is an unknown RID, not a failure");
  check(canvas(s, 1)->xform == kRootXform, "skip: the root canvas is untouched");
}

void test_skip_unknown_parent() {
  Mirror m;
  skip_root(&m);
  // Created after arming, parented to an unknown RID: withheld with its whole subtree.
  m.canvas_item_create(100, 1);  // item 1
  m.canvas_item_create(101, 1);  // item 2
  m.canvas_item_create(102, 1);  // item 3, a drawing sibling on the root
  m.set_parent(100, kUnknownParent, 1);
  m.set_parent(101, 100, 1);
  m.set_parent(102, kRootCanvas, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  m.add_rect(101, kRect, kRed, false, 1);
  m.add_unsupported(101, "canvas_item_add_particles", 1);
  m.add_rect(102, kRect, kGreen, false, 1);
  // Withheld siblings would tie; a withheld item's entries are not published.
  m.canvas_item_create(103, 1);  // item 4, a second drawing child of item 1
  m.set_parent(103, 100, 1);
  m.add_rect(103, kRect, kRed, false, 1);
  Snapshot s = m.snapshot(1, 1).state;
  check(item_ids(s) == std::vector<uint32_t>{3}, "skip: items 1, 2 and 4 are withheld");
  check(canvas(s, 1)->items == ids({3}), "skip: only the clean item is on the root canvas");
  check(unknown_counts(s, 1, 3, 4, 1), "skip: 1 unknown RID, 3 withheld items holding 4 commands");
  check(s.unsupported.empty(), "skip: no entry (unsupported op, tie) for a withheld item");
  check(s.failures.empty(), "skip: no failure");

  // A tie between two *published* siblings is still declared.
  m.set_parent(100, kRootCanvas, 2);  // item 1 (never published: keeps its id) joins item 3 at 0
  s = m.snapshot(2, 2).state;
  check(item_ids(s) == (std::vector<uint32_t>{1, 2, 3, 4}), "skip: reparented out, published");
  check(canvas(s, 1)->items == ids({3, 1}) && item(s, 1)->children == ids({2, 4}),
        "skip: the subtree keeps its child order");
  check(unknown_counts(s, 1, 0, 0, 1), "skip: the unknown RID stays unknown until freed");
  check(ties(s) == (std::vector<Entry>{tie(1), tie(2)}) && item_entries(s).size() == 3,
        "skip: published items get their entries back (two ties + the particles op)");
  check(m.stats().rekeyed_items == 0, "skip: nothing published was withheld, nothing re-keyed");
}

void test_skip_reparent_into_and_out_of_withheld() {
  Mirror m;
  skip_root(&m);
  m.canvas_item_create(100, 1);  // item 1
  m.canvas_item_create(101, 1);  // item 2
  m.canvas_item_create(102, 1);  // item 3: withheld from the start
  m.set_parent(100, kRootCanvas, 1);
  m.set_parent(101, 100, 1);
  m.set_parent(102, kUnknownParent, 1);
  m.add_rect(101, kRect, kRed, false, 1);
  Snapshot s1 = m.snapshot(1, 1).state;
  check(item_ids(s1) == (std::vector<uint32_t>{1, 2}), "published subtree 1, 2");

  // Into a withheld *known* item: the published subtree leaves and is re-keyed.
  m.set_parent(100, 102, 2);
  Snapshot s2 = m.snapshot(2, 2).state;
  check(item_ids(s2).empty() && canvas(s2, 1)->items.empty(), "skip: subtree withheld");
  check(unknown_counts(s2, 1, 3, 1, 1), "skip: 3 withheld items, 1 command");
  check(m.stats().rekeyed_items == 2, "skip: both published items re-keyed (item 3 was not)");

  // Out again: published under fresh ids, never the old ones (id-reused).
  m.set_parent(100, kRootCanvas, 3);
  Snapshot s3 = m.snapshot(3, 3).state;
  check(item_ids(s3) == (std::vector<uint32_t>{4, 5}), "skip: ids 4 and 5 replace 1 and 2");
  check(canvas(s3, 1)->items == ids({4}) && item(s3, 4)->children == ids({5}) &&
            item(s3, 5)->parent.kind == ParentKind::Item && item(s3, 5)->parent.id == 4,
        "skip: the re-keyed subtree is internally consistent");
  check(item(s3, 5)->commands.size() == 1, "skip: its commands survived the stay");
  check(unknown_counts(s3, 1, 1, 0, 1), "skip: item 3 alone still withheld");
  // A RID keeps addressing its item after the re-key.
  m.set_visible(101, false, 4);
  Snapshot s4 = m.snapshot(4, 4).state;
  check(!item(s4, 5)->visible, "skip: the RID follows the new id");

  // Directly into an unknown parent, after being published: re-keyed again.
  m.set_parent(100, kUnknownParent, 5);
  m.set_parent(100, kRootCanvas, 5);  // and back within the same frame
  Snapshot s5 = m.snapshot(5, 5).state;
  check(item_ids(s5) == (std::vector<uint32_t>{6, 7}), "skip: a round trip still re-keys");
}

void test_skip_free_unknown() {
  Mirror m;
  skip_root(&m);
  m.canvas_item_create(100, 1);  // item 1
  m.set_parent(100, kUnknownParent, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  Snapshot s = m.snapshot(1, 1).state;
  check(item_ids(s).empty() && unknown_counts(s, 1, 1, 1, 1), "withheld under the unknown RID");

  // The engine frees the unknown parent: dropped silently, the child is an orphan, published.
  m.free_rid(kUnknownParent, 2);
  s = m.snapshot(2, 2).state;
  check(m.stats().free_unknown == 0, "skip: a freed unknown RID is not free_unknown");
  check(unknown_counts(s, 0, 0, 0, 1), "skip: nothing withheld any more");
  check(item_ids(s) == std::vector<uint32_t>{1} && item(s, 1)->parent.kind == ParentKind::None,
        "skip: the orphan is published with no parent");
  check(s.failures.empty(), "skip: no failure");
  // Now an unknown RID again only if named again; a second free is an ordinary unknown free.
  m.free_rid(kUnknownParent, 3);
  check(m.stats().free_unknown == 1, "skip: a RID no longer remembered is free_unknown");

  // Freeing an unknown *item* the mirror only saw named.
  m.set_transform(kUnknownItem, kRootXform, 4);
  s = m.snapshot(3, 4).state;
  check(unknown_counts(s, 1, 0, 0, 2), "named once");
  m.free_rid(kUnknownItem, 5);
  s = m.snapshot(4, 5).state;
  check(unknown_counts(s, 0, 0, 0, 2) && m.stats().unknown_rids_named == 2,
        "skip: freed silently, still counted as named");

  // A recycled RID value created anew is a known item, not an unknown one.
  m.set_parent(kUnknownItem, kRootCanvas, 6);  // named again: unknown
  m.free_rid(kUnknownItem, 6);
  m.canvas_item_create(kUnknownItem, 6);
  m.set_parent(kUnknownItem, kRootCanvas, 6);
  s = m.snapshot(5, 6).state;
  check(unknown_counts(s, 0, 0, 0, 3) && item_ids(s) == (std::vector<uint32_t>{1, 2}),
        "skip: a created RID is known");
}

void test_skip_patch_full_equivalence() {
  Mirror m;
  skip_root(&m);
  std::vector<Snapshot> states;
  // 1: a clean subtree, a withheld one, a pre-existing item drawing.
  m.canvas_item_create(100, 1);
  m.canvas_item_create(101, 1);
  m.canvas_item_create(102, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.set_parent(101, 100, 1);
  m.set_parent(102, kUnknownParent, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  m.add_rect(101, kRect, kRed, false, 1);
  m.add_rect(102, kRect, kGreen, false, 1);
  m.add_rect(kUnknownItem, kRect, kGreen, false, 1);
  states.push_back(m.snapshot(1, 1).state);
  // 2: a published subtree moves under the withheld item.
  m.set_parent(100, 102, 2);
  states.push_back(m.snapshot(2, 2).state);
  // 3: the withheld item moves out (to the root) with its new child.
  m.set_parent(102, kRootCanvas, 3);
  m.set_draw_index(102, 4, 3);
  states.push_back(m.snapshot(3, 3).state);
  // 4: a redraw of a withheld-then-published item, and the unknown parent freed.
  m.clear(101, 4);
  m.add_rect(101, kRect, kGreen, false, 4);
  m.free_rid(kUnknownParent, 4);
  states.push_back(m.snapshot(4, 4).state);
  // 5: back under an unknown RID, then that RID freed in the same frame (orphaned, re-published).
  m.set_parent(100, kUnknownParent, 5);
  m.free_rid(kUnknownParent, 5);
  states.push_back(m.snapshot(5, 5).state);
  // 6: nothing changes.
  states.push_back(m.snapshot(6, 6).state);

  Snapshot resolved = grc::rs2::resolve(Snapshot(), grc::rs2::make_full(states[0]));
  check(same_state(resolved, states[0]), "skip: full of state 1 resolves to it");
  std::vector<uint32_t> ever;  // every id ever published
  for (uint32_t id : item_ids(states[0])) ever.push_back(id);
  for (std::size_t i = 1; i < states.size(); ++i) {
    const grc::rs2::Transaction patch = grc::rs2::make_patch(states[i - 1], states[i]);
    const grc::rs2::Transaction full = grc::rs2::make_full(states[i]);
    check(patch.unknown_items.present && full.unknown_items.present &&
              patch.unknown_items.withheld_items == full.unknown_items.withheld_items &&
              patch.unknown_items.unknown_calls == full.unknown_items.unknown_calls,
          "skip: unknown_items complete in patch and full (state " + std::to_string(i + 1) + ")");
    resolved = grc::rs2::resolve(resolved, patch);
    check(same_state(resolved, states[i]),
          "skip: patch chain resolves to the full state " + std::to_string(i + 1));
    check(same_state(grc::rs2::resolve(Snapshot(), full), states[i]),
          "skip: full resolves to state " + std::to_string(i + 1));
    // render-stream-0.md id-reused: an id absent from the previous state never comes back.
    const std::vector<uint32_t> prev = item_ids(states[i - 1]);
    for (uint32_t id : item_ids(states[i])) {
      const bool in_prev = std::find(prev.begin(), prev.end(), id) != prev.end();
      const bool seen = std::find(ever.begin(), ever.end(), id) != ever.end();
      check(in_prev || !seen, "skip: id " + std::to_string(id) + " never reappears (state " +
                                  std::to_string(i + 1) + ")");
      if (!seen) ever.push_back(id);
    }
  }
  check(unknown_counts(states[0], 2, 1, 1, 2), "state 1 account");
  check(unknown_counts(states[1], 2, 3, 3, 2), "state 2 account");
  check(unknown_counts(states[2], 2, 0, 0, 2), "state 3 account");
  check(unknown_counts(states[3], 1, 0, 0, 2), "state 4 account");
  check(unknown_counts(states[4], 1, 0, 0, 3), "state 5 account (unknown parent named again)");
  check(states[4].items.size() == 3, "state 5: the orphaned subtree is published again");
}

// --- G55d: shaders, materials, item and canvas material state (gate5_5-design.md Q3b) -----------

// A shader code as the hook hands it over: classification plus the GRP1 payload.
grc::rs::ShaderCodeInput shader_input(const std::string &code, const char *status = "ok",
                                      const char *reason = "", bool builtin = false,
                                      const char *blend = "mix", const char *light = "normal") {
  grc::rs::ShaderCodeInput input;
  input.copy.status = status;
  input.copy.reason = reason;
  input.copy.mode = "canvas_item";
  input.copy.builtin = builtin;
  input.copy.builtin_blend_mode = blend;
  input.copy.builtin_light_mode = light;
  input.copy.code_bytes = static_cast<int64_t>(code.size());
  auto payload =
      std::make_shared<grc::rs::PayloadBytes>(grc::rs::encode_payload(code));
  input.copy.hash = grc::sha256_hex(payload->data(), payload->size());
  input.copy.payload_bytes = static_cast<int64_t>(payload->size());
  input.bytes = payload;
  return input;
}

grc::rs::DecodedParam scalar(const char *type, std::vector<double> f) {
  grc::rs::DecodedParam p;
  p.type = type;
  p.n = 1;
  p.f = std::move(f);
  return p;
}

const grc::rs2::ShaderEntry *shader(const Snapshot &s, uint32_t id) {
  for (const auto &e : s.shaders)
    if (e.id == id) return &e;
  return nullptr;
}

const grc::rs2::MaterialEntry *material(const Snapshot &s, uint32_t id) {
  for (const auto &e : s.materials)
    if (e.id == id) return &e;
  return nullptr;
}

bool has_entry(const Snapshot &s, uint32_t item_id, const char *op, UnsupportedReason reason) {
  for (const auto &u : s.unsupported)
    if (u.has_item && u.item == item_id && u.op == op && u.reason == reason) return true;
  return false;
}

const char kCimAdd[] = "shader_type canvas_item;\nrender_mode blend_add;\n";
const char kTint[] = "shader_type canvas_item;\nuniform vec4 tint;\nvoid fragment() {\n\tCOLOR = tint;\n}\n";

void test_material_tables_lifecycle() {
  using grc::rs2::ShaderStatus;
  using grc::rs2::VariantType;
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);  // item 1
  m.set_parent(100, kRootCanvas, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  // CanvasItemMaterial.new() + the idle flush (Q1a): material_create, three params, then
  // shader_create + shader_set_code + material_set_shader.
  m.material_create(0x700, 1);
  m.material_set_param(0x700, "particles_anim_h_frames", scalar("int", {1}), 1);
  m.material_set_param(0x700, "particles_anim_v_frames", scalar("int", {1}), 1);
  m.material_set_param(0x700, "particles_anim_loop", scalar("bool", {0}), 1);
  m.set_material(100, 0x700, 1);
  const auto add = shader_input(kCimAdd, "ok", "", true, "add", "normal");
  m.shader_create(0x800, 1);
  m.shader_set_code(0x800, add, 1);
  m.material_set_shader(0x700, 0x800, 1);
  grc::rs::Captured cap = m.snapshot(1, 1);
  const Snapshot &s = cap.state;
  const auto *sh = shader(s, 1);
  const auto *mat = material(s, 1);
  check(s.shaders.size() == 1 && sh != nullptr && sh->version == 2 &&
            sh->status == ShaderStatus::Ok && sh->has_mode && sh->has_source &&
            sh->source == grc::rs2::ShaderSource::Payload && sh->hash == add.copy.hash &&
            sh->payload_bytes == add.bytes->size(),
        "shader_create + set_code: id 1, version 2, payload source, the hook's hash and size");
  check(sh != nullptr && sh->has_builtin &&
            sh->builtin.blend_mode == grc::rs2::BlendMode::Add &&
            sh->builtin.light_mode == grc::rs2::LightMode::Normal,
        "a recognized CanvasItemMaterial shader carries its builtin blend and light modes");
  check(cap.payloads.count(add.copy.hash) == 1 &&
            cap.payloads.at(add.copy.hash).get() == add.bytes.get(),
        "the snapshot pins the ok shader's GRP1 payload, shared");
  check(mat != nullptr && mat->version == 5 && mat->has_shader && mat->shader == 1 &&
            mat->params.size() == 3 && mat->params[0].name == "particles_anim_h_frames" &&
            mat->params[1].name == "particles_anim_loop" &&
            mat->params[2].name == "particles_anim_v_frames" &&
            mat->params[1].type == VariantType::Bool && mat->params[0].type == VariantType::Int &&
            mat->params[0].floats == std::vector<double>{1.0},
        "material: version 1 + 3 params + set_shader = 5, params sorted by name, typed values");
  const auto *it = item(s, 1);
  check(it != nullptr && it->has_material && it->material == 1 && it->content_version == 1,
        "the item names material 1; setting a material does not redraw (D9)");
  check(s.unsupported.empty(), "a supported material gives no unsupported entry (/5)");

  // D5: freeing the shader while the material names it nulls the material (version + 1).
  m.free_rid(0x800, 2);
  cap = m.snapshot(2, 2);
  mat = material(cap.state, 1);
  check(cap.state.shaders.empty() && mat != nullptr && !mat->has_shader && mat->version == 6,
        "free(shader): no tombstone; its material goes to shader null at version + 1");
  check(cap.payloads.empty(), "a freed shader's payload is no longer pinned");
  // Freeing the material resets every item naming it.
  m.free_rid(0x700, 3);
  cap = m.snapshot(3, 3);
  it = item(cap.state, 1);
  check(cap.state.materials.empty() && it != nullptr && !it->has_material,
        "free(material): no tombstone; the item's material goes to null");
  // Recreation gets new ids.
  m.material_create(0x700, 4);
  m.shader_create_from_code(0x801, shader_input(kTint), 4);
  m.material_set_shader(0x700, 0x801, 4);
  cap = m.snapshot(4, 4);
  check(material(cap.state, 2) != nullptr && shader(cap.state, 2) != nullptr &&
            shader(cap.state, 2)->version == 1 && !shader(cap.state, 2)->has_builtin,
        "a recreated material and a new shader take fresh ids; create_from_code is version 1");
}

// P3-CAP: the mirror republishes an unchanged material's parameters without rebuilding them (the
// same shared storage); any change (version + 1) rebuilds them with the new values, and the
// derived unsupported-material entry follows the rebuilt status.
void test_material_params_shared() {
  using grc::rs2::MaterialStatus;
  Mirror m;
  bind_root(&m);
  m.material_create(0x700, 1);
  m.material_set_param(0x700, "tint", scalar("color", {0.2, 0.4, 0.6, 1.0}), 1);
  m.canvas_item_create(0x100, 1);
  m.set_parent(0x100, kRootCanvas, 1);
  m.set_material(0x100, 0x700, 1);
  const Snapshot first = m.snapshot(1, 1).state;
  const Snapshot again = m.snapshot(2, 2).state;
  check(material(again, 1)->params.shares(material(first, 1)->params),
        "an unchanged material shares its parameters with the previous snapshot");
  m.material_set_param(0x700, "tint", scalar("color", {1.0, 0.4, 0.6, 1.0}), 3);
  const Snapshot changed = m.snapshot(3, 3).state;
  check(!material(changed, 1)->params.shares(material(first, 1)->params) &&
            material(changed, 1)->params[0].floats[0] == 1.0 &&
            material(first, 1)->params[0].floats[0] == 0.2,
        "a set parameter is rebuilt; the earlier snapshot keeps its own values");
  grc::rs::DecodedParam str;
  str.type = "string";
  str.status = "unsupported";
  str.reason = "param-type";
  m.material_set_param(0x700, "label", str, 4);
  const Snapshot bad = m.snapshot(4, 4).state;
  bool entry = false;
  for (const auto &u : bad.unsupported) {
    entry = entry || (u.has_item && u.op == "canvas_item_set_material");
  }
  check(material(bad, 1)->status == MaterialStatus::Unsupported && entry,
        "an unsupported parameter: the entry and its item's unsupported-material follow");
  m.material_set_param(0x700, "label", scalar("nil", {}), 5);
  const Snapshot fixed = m.snapshot(5, 5).state;
  entry = false;
  for (const auto &u : fixed.unsupported) {
    entry = entry || (u.has_item && u.op == "canvas_item_set_material");
  }
  check(material(fixed, 1)->status == MaterialStatus::Ok && !entry,
        "erased again: ok, and no unsupported-material entry");
}

void test_material_params() {
  using grc::rs2::MaterialReason;
  using grc::rs2::MaterialStatus;
  using grc::rs2::VariantType;
  Mirror m;
  bind_root(&m);
  grc::rs::PayloadPtr tex_bytes;
  m.texture_2d_create(0x500, rgba8_copy(4, 4, fill(4, 4, 10), &tex_bytes), tex_bytes, 1);  // tex 1
  m.material_create(0x700, 1);
  m.material_set_param(0x700, "tint", scalar("color", {0.2, 0.4, 0.6, 1.0}), 1);
  grc::rs::DecodedParam lv;
  lv.type = "float32";
  lv.packed = true;
  lv.n = 2;
  lv.f = {0.25, 0.5};
  m.material_set_param(0x700, "lv", lv, 1);
  grc::rs::DecodedParam tex;
  tex.type = "rid";
  tex.n = 1;
  tex.tex_rid = 0x500;
  m.material_set_param(0x700, "pal", tex, 1);
  Snapshot s = m.snapshot(1, 1).state;
  const auto *mat = material(s, 1);
  check(mat != nullptr && mat->status == MaterialStatus::Ok && mat->version == 4 &&
            mat->params.size() == 3 && mat->params[0].name == "lv" &&
            mat->params[0].type == VariantType::PackedFloat32Array && mat->params[0].n == 2 &&
            mat->params[1].name == "pal" && mat->params[1].type == VariantType::Rid &&
            mat->params[1].has_tex && mat->params[1].tex == 1 && mat->params[1].floats.empty() &&
            mat->params[2].floats.size() == 4,
        "a packed float32 array (n 2), a rid naming texture 1, a colour: sorted, typed");
  // OBJECT is rejected (no change, no version); NIL erases.
  grc::rs::DecodedParam object;
  object.type = "object";
  object.status = "unsupported";
  object.reason = "param-type";
  m.material_set_param(0x700, "tint", object, 2);
  s = m.snapshot(2, 2).state;
  check(material(s, 1)->version == 4 && material(s, 1)->params.size() == 3,
        "an OBJECT value is rejected: no change, no version (D6)");
  m.material_set_param(0x700, "tint", scalar("nil", {}), 3);
  s = m.snapshot(3, 3).state;
  check(material(s, 1)->version == 5 && material(s, 1)->params.size() == 2,
        "NIL erases the parameter, version + 1");
  // A texture a parameter names becomes a tombstone when freed, not a dangling id.
  m.free_rid(0x500, 4);
  s = m.snapshot(4, 4).state;
  check(s.textures.size() == 1 && s.textures[0].status == grc::rs2::TextureStatus::Freed,
        "a freed texture a material parameter names is kept as a tombstone");
  // An unsupported type makes the entry unsupported until that name is set again.
  grc::rs::DecodedParam str;
  str.type = "string";
  str.status = "unsupported";
  str.reason = "param-type";
  m.material_set_param(0x700, "label", str, 5);
  s = m.snapshot(5, 5).state;
  mat = material(s, 1);
  check(mat->status == MaterialStatus::Unsupported && mat->has_reason &&
            mat->reason == MaterialReason::ParamType && mat->params.size() == 2,
        "a param-type value: the entry is unsupported/param-type and the value is not carried");
  m.material_set_param(0x700, "label", scalar("float", {0.5}), 6);
  s = m.snapshot(6, 6).state;
  check(material(s, 1)->status == MaterialStatus::Ok && material(s, 1)->params.size() == 3,
        "setting that name to a supported value makes the entry ok again");
  grc::rs::DecodedParam unknown_tex = tex;
  unknown_tex.tex_rid = 0x999;
  m.material_set_param(0x700, "pal", unknown_tex, 7);
  s = m.snapshot(7, 7).state;
  check(material(s, 1)->reason == MaterialReason::UnknownTexture,
        "a rid naming an unknown texture makes the entry unknown-texture");
  // material_create_from_shader with an unknown shader RID.
  m.material_create_from_shader(0x701, 0x888, 8);
  s = m.snapshot(8, 8).state;
  check(material(s, 2) != nullptr && !material(s, 2)->has_shader &&
            material(s, 2)->reason == MaterialReason::UnknownShader,
        "create_from_shader with an unknown shader RID: shader null, unknown-shader");
}

void test_material_items_and_derived_entries() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);  // 1: parent with the material
  m.canvas_item_create(101, 1);  // 2: child, use_parent_material
  m.canvas_item_create(102, 1);  // 3: unknown material
  m.canvas_item_create(103, 1);  // 4: instance params
  m.set_parent(100, kRootCanvas, 1);
  m.set_parent(101, 100, 1);
  m.set_parent(102, kRootCanvas, 1);
  m.set_parent(103, kRootCanvas, 1);
  m.set_draw_index(102, 1, 1);
  m.set_draw_index(103, 2, 1);
  m.shader_create_from_code(0x800, shader_input(kTint, "unsupported", "shader-time"), 1);
  m.material_create_from_shader(0x700, 0x800, 1);
  m.set_material(100, 0x700, 1);
  m.set_use_parent_material(101, true, 1);
  m.set_material(102, 0x777, 1);
  m.set_instance_shader_parameter(103, "inst_color", scalar("color", {0.2, 0.8, 0.4, 1}), 1);
  grc::rs::DecodedParam str;
  str.type = "string";
  str.status = "unsupported";
  str.reason = "param-type";
  m.set_instance_shader_parameter(103, "label", str, 1);
  m.set_instance_shader_parameter(103, "unset", scalar("nil", {}), 1);
  grc::rs::Captured cap = m.snapshot(1, 1);
  const Snapshot &s = cap.state;
  check(shader(s, 1) != nullptr && shader(s, 1)->status == grc::rs2::ShaderStatus::Unsupported &&
            shader(s, 1)->reason == grc::rs2::ShaderReason::ShaderTime &&
            shader(s, 1)->has_hash,
        "a shader-time shader is unsupported but keeps its hash");
  check(cap.payloads.empty(), "an unsupported shader's payload is not carried");
  check(has_entry(s, 1, "canvas_item_set_material", UnsupportedReason::UnsupportedMaterial),
        "the item naming the unsupported shader's material: unsupported-material");
  check(has_entry(s, 2, "canvas_item_set_material", UnsupportedReason::UnsupportedMaterial) &&
            !item(s, 2)->has_material && item(s, 2)->use_parent_material,
        "its use_parent_material child (own material null): unsupported-material (D9 effective)");
  check(has_entry(s, 3, "canvas_item_set_material", UnsupportedReason::UnknownMaterial) &&
            !item(s, 3)->has_material,
        "an unknown material RID: material null plus unknown-material");
  const auto *four = item(s, 4);
  check(has_entry(s, 4, "canvas_item_set_instance_shader_parameter", UnsupportedReason::ParamType) &&
            four->instance_params.size() == 2 && four->instance_params[0].name == "inst_color" &&
            four->instance_params[1].name == "unset" &&
            four->instance_params[1].type == grc::rs2::VariantType::Nil &&
            four->content_version == 0,
        "instance params: supported ones carried sorted, NIL kept as nil, a param-type entry");
  check(s.unsupported.size() == 4, "exactly four item-level entries");
  // The child stops inheriting: its entry leaves.
  m.set_use_parent_material(101, false, 2);
  check(!has_entry(m.snapshot(2, 2).state, 2, "canvas_item_set_material",
                   UnsupportedReason::UnsupportedMaterial),
        "use_parent_material off: the child's effective material is its own (null)");
}

void test_canvas_modulate_and_light() {
  Mirror m;
  bind_root(&m);
  m.canvas_set_modulate(kRootCanvas, Color4{1, 1, 0, 1}, 2);
  Snapshot s = m.snapshot(2, 2).state;
  check(s.canvases[0].modulate == Color4({1, 1, 0, 1}), "canvas_set_modulate: the canvas field");
  m.canvas_light_attach_to_canvas(0x900, 0, 3);
  check(m.snapshot(3, 3).state.unsupported.empty(), "a light attached to RID() is not typed");
  m.canvas_light_attach_to_canvas(0x900, kRootCanvas, 3);
  m.canvas_light_attach_to_canvas(0x901, kRootCanvas, 3);
  s = m.snapshot(3, 3).state;
  check(s.unsupported.size() == 1 && !s.unsupported[0].has_item &&
            s.unsupported[0].op == "canvas_light_attach_to_canvas" &&
            s.unsupported[0].reason == UnsupportedReason::CanvasLight,
        "a light on a canvas: one sticky session-level canvas-light entry");
  m.canvas_set_modulate(0x4444, Color4{0, 1, 1, 1}, 4);
  s = m.snapshot(4, 4).state;
  check(s.failures.size() == 1 && s.failures[0].reason == FailureReason::PreExistingObject,
        "an unknown canvas RID follows the unknown-RID rule");
}

// G6b (gate6-design.md Q3b): attach resets the stacking, removal detaches but keeps the items,
// a tie between two attached canvases is derived per snapshot, and the patch carries exactly the
// one changed canvas.
void test_canvas_layers() {
  Mirror m;
  bind_root(&m);
  m.canvas_create(300, 1);  // canvas 2
  m.canvas_create(301, 1);  // canvas 3
  m.canvas_item_create(110, 1);
  m.set_parent(110, 300, 1);
  m.viewport_attach_canvas(kRootViewport, 300, 1);
  m.viewport_set_canvas_stacking(kRootViewport, 300, 1, 0, 1);
  Snapshot s1 = m.snapshot(1, 1).state;
  check(s1.unsupported.empty(), "a stacked layer attached in the same frame: no tie, no entry");
  check(canvas(s1, 2)->attached && canvas(s1, 2)->layer == 1 && canvas(s1, 2)->sublayer == 0 &&
            canvas(s1, 3)->layer == 0 && !canvas(s1, 3)->attached,
        "layer 1 on the attached canvas; the unattached one keeps (0,0)");
  // Layer change only: the patch carries exactly that canvas.
  m.viewport_set_canvas_stacking(kRootViewport, 300, -1, 0, 2);
  Snapshot s2 = m.snapshot(2, 2).state;
  const grc::rs2::Transaction patch = grc::rs2::make_patch(s1, s2);
  check(patch.canvases.size() == 1 && patch.canvases[0].id == 2 && patch.canvases[0].layer == -1,
        "a layer change patches exactly one canvas entry");
  // Removal: attached false, items kept.
  m.viewport_remove_canvas(kRootViewport, 300, 3);
  Snapshot s3 = m.snapshot(3, 3).state;
  check(!canvas(s3, 2)->attached && canvas(s3, 2)->items == std::vector<uint32_t>{1} &&
            canvas(s3, 2)->layer == -1,
        "removal: attached false, items and stacking kept");
  // Re-attach resets the stacking to (0,0) -> tie with the root until set; a third canvas at the
  // same key ties too.
  m.viewport_attach_canvas(kRootViewport, 300, 4);
  Snapshot s4 = m.snapshot(4, 4).state;
  check(canvas(s4, 2)->attached && canvas(s4, 2)->layer == 0 && s4.unsupported.size() == 1 &&
            s4.unsupported[0].reason == UnsupportedReason::CanvasStackingTie,
        "re-attach resets to (0,0): a tie with the root canvas");
  m.viewport_set_canvas_stacking(kRootViewport, 300, 2, 0, 4);
  m.viewport_attach_canvas(kRootViewport, 301, 4);
  m.viewport_set_canvas_stacking(kRootViewport, 301, 2, 0, 4);
  s4 = m.snapshot(4, 4).state;
  check(s4.unsupported.size() == 1 && s4.unsupported[0].op == "viewport_set_canvas_stacking",
        "two attached layers at (2,0): one canvas-stacking-tie entry");
  m.viewport_set_canvas_stacking(kRootViewport, 301, 2, 1, 5);
  check(m.snapshot(5, 5).state.unsupported.empty(), "a distinct sublayer resolves the tie");
  // Non-root viewport stacking is non-root-viewport and changes nothing.
  m.viewport_set_canvas_stacking(0x9999, 301, 7, 7, 6);
  m.viewport_remove_canvas(0x9999, 301, 6);
  Snapshot s6 = m.snapshot(6, 6).state;
  check(canvas(s6, 3)->layer == 2 && canvas(s6, 3)->attached && s6.unsupported.size() == 2 &&
            s6.unsupported[0].reason == UnsupportedReason::NonRootViewport &&
            s6.unsupported[1].op == "viewport_remove_canvas",
        "stacking / removal on a non-root viewport: non-root-viewport, mirror unchanged");
  // omit-op drops the stacking tap.
  Mirror o;
  bind_root(&o);
  o.set_omit_op("viewport_set_canvas_stacking", 2);
  o.canvas_create(300, 1);
  o.viewport_attach_canvas(kRootViewport, 300, 1);
  o.viewport_set_canvas_stacking(kRootViewport, 300, 1, 0, 1);
  o.viewport_set_canvas_stacking(kRootViewport, 300, 5, 0, 2);
  check(canvas(o.snapshot(2, 2).state, 2)->layer == 1, "omit-op viewport_set_canvas_stacking");
}

// G6b (Q3b, D17): the sticky repeat/follow entries, the non-sticky global canvas transform, and
// snap-2d, in their documented order.
void test_canvas_session_entries() {
  Mirror m;
  bind_root(&m);
  m.set_global_canvas_reference({0.5f, 0, 0, 0.5f, 0, 0});
  m.viewport_set_global_canvas_transform(kRootViewport, {0.5f, 0, 0, 0.5f, 0, 0}, 1);
  check(m.snapshot(1, 1).state.unsupported.empty(),
        "a global canvas transform equal to the reference is not typed");
  m.canvas_set_parent(300, 0, 1);
  m.canvas_set_item_mirroring(300, 110, 0, 0, 1);
  m.canvas_set_item_repeat(110, 0, 0, 1, 1);
  check(m.snapshot(1, 1).state.unsupported.empty(), "RID() parent and zero vectors are not typed");
  m.canvas_set_item_repeat(110, 64, 0, 2, 2);
  m.canvas_set_parent(300, 0x7777, 2);
  m.canvas_set_item_mirroring(300, 110, 32, 0, 2);
  m.viewport_set_global_canvas_transform(kRootViewport, {0.5f, 0, 0, 0.5f, 8, 4}, 2);
  m.set_snap_2d(false, true);
  Snapshot s = m.snapshot(2, 2).state;
  check(s.unsupported.size() == 5, "five session-level entries");
  if (s.unsupported.size() == 5) {
    check(s.unsupported[0].reason == UnsupportedReason::Snap2d &&
              s.unsupported[0].op == "viewport_set_snap_2d_vertices_to_pixel",
          "snap-2d first, named after the vertices setter when only that flag is set");
    check(s.unsupported[1].reason == UnsupportedReason::CanvasRepeat &&
              s.unsupported[1].op == "canvas_set_item_repeat",
          "then canvas-repeat (repeat observed first)");
    check(s.unsupported[2].reason == UnsupportedReason::CanvasFollowViewport &&
              s.unsupported[2].op == "canvas_set_parent",
          "then canvas-follow-viewport");
    check(s.unsupported[3].reason == UnsupportedReason::CanvasRepeat &&
              s.unsupported[3].op == "canvas_set_item_mirroring",
          "then canvas-repeat named after the mirroring op");
    check(s.unsupported[4].reason == UnsupportedReason::GlobalCanvasTransform,
          "then global-canvas-transform while it differs");
  }
  m.viewport_set_global_canvas_transform(kRootViewport, {0.5f, 0, 0, 0.5f, 0, 0}, 3);
  m.set_snap_2d(true, true);
  s = m.snapshot(3, 3).state;
  check(s.unsupported.size() == 4 &&
            s.unsupported[0].op == "viewport_set_snap_2d_transforms_to_pixel",
        "global-canvas-transform leaves once equal again; sticky ones stay; snap names transforms");
  m.viewport_set_global_canvas_transform(0x9999, {1, 0, 0, 1, 0, 0}, 4);
  s = m.snapshot(4, 4).state;
  check(s.unsupported.size() == 5 && s.unsupported[4].reason == UnsupportedReason::NonRootViewport,
        "a non-root viewport's global transform is non-root-viewport");
  m.reset();
  check(m.snapshot(5, 5).state.unsupported.empty(), "reset clears snap, the reference and stickies");
}

void test_shader_policy_and_perturb() {
  using grc::rs2::ShaderSource;
  using grc::rs2::ShaderStatus;
  for (const auto policy : {grc::rs2::ShaderPolicy::Params, grc::rs2::ShaderPolicy::Exclude}) {
    Mirror m;
    bind_root(&m);
    m.set_shader_policy(policy);
    const auto tint = shader_input(kTint);
    const auto cim = shader_input(kCimAdd, "ok", "", true, "add", "normal");
    m.shader_create_from_code(0x800, tint, 1);
    m.shader_create(0x801, 1);
    m.shader_set_code(0x801, cim, 1);
    grc::rs::Captured cap = m.snapshot(1, 1);
    const auto *a = shader(cap.state, 1);
    const auto *b = shader(cap.state, 2);
    const bool params = policy == grc::rs2::ShaderPolicy::Params;
    check(a != nullptr && a->source == ShaderSource::Withheld && a->hash == tint.copy.hash &&
              a->payload_bytes == tint.bytes->size() &&
              (params ? a->status == ShaderStatus::Ok
                      : (a->status == ShaderStatus::Unsupported &&
                         a->reason == grc::rs2::ShaderReason::ShaderExcluded)),
          params ? "params: a custom shader is withheld with the hash and size it would have"
                 : "exclude: a custom shader is unsupported/shader-excluded, withheld");
    check(b != nullptr && b->source == ShaderSource::Payload && b->status == ShaderStatus::Ok &&
              cap.payloads.size() == 1 && cap.payloads.count(cim.copy.hash) == 1,
          "the builtin CanvasItemMaterial shader still travels as a payload (D4, D7)");
  }
  // perturb-shader (Q3c): from its frame, a non-builtin code with fragment() ending in } moves.
  Mirror m;
  bind_root(&m);
  m.set_perturb_shader(3);
  const auto tint = shader_input(kTint);
  m.shader_create_from_code(0x800, tint, 1);
  m.shader_create_from_code(0x802, shader_input(kCimAdd, "ok", "", true, "add"), 3);
  check(shader(m.snapshot(1, 1).state, 1)->hash == tint.copy.hash,
        "perturb-shader: code recorded before its frame never moves");
  m.shader_set_code(0x800, tint, 3);
  grc::rs::Captured cap = m.snapshot(3, 3);
  const auto *a = shader(cap.state, 1);
  const std::string expected = std::string(kTint).insert(
      std::string(kTint).rfind('}'), "\tCOLOR.rgb = vec3(1.0) - COLOR.rgb;\n");
  const auto want = grc::rs::encode_payload(expected);
  check(a != nullptr && a->hash == grc::sha256_hex(want.data(), want.size()) &&
            a->payload_bytes == want.size() && cap.payloads.count(a->hash) == 1 &&
            *cap.payloads.at(a->hash) == want,
        "perturb-shader: the inversion line before the last }, a new payload and hash");
  check(shader(cap.state, 2)->hash == shader_input(kCimAdd).copy.hash,
        "perturb-shader never touches a builtin shader");
}

void test_material_omit_op() {
  Mirror m;
  bind_root(&m);
  m.set_omit_op("material_set_shader", 2);
  m.material_create(0x700, 1);
  m.shader_create(0x800, 1);
  m.shader_set_code(0x800, shader_input(kCimAdd, "ok", "", true, "add"), 1);
  m.material_set_shader(0x700, 0x800, 1);
  m.shader_create(0x801, 2);
  m.shader_set_code(0x801, shader_input(kCimAdd, "ok", "", true, "sub"), 2);
  m.free_rid(0x800, 2);
  m.material_set_shader(0x700, 0x801, 2);  // omitted
  const Snapshot s = m.snapshot(2, 2).state;
  check(material(s, 1) != nullptr && !material(s, 1)->has_shader && material(s, 1)->version == 3,
        "omit-op material_set_shader: the old shader's free still nulls it; the new bind is lost");
}

// CG1 (render-stream-10.md "Capture"): the two back-buffer setters. Each replaces the item's
// state whole (disabled / enable false clears it, keeping no argument), neither bumps
// content_version, canvas_item_clear keeps both, an out-of-range mode changes nothing, an unknown
// item is the unknown-RID rule, and omit-op drops the call by its RenderingServer name.
void test_backbuffer_state() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.canvas_item_create(101, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.set_parent(101, kRootCanvas, 1);
  m.set_draw_index(101, 1, 1);
  m.set_canvas_group_mode(100, 3, 10.0f, true, 10.0f, true, 1);
  m.set_copy_to_backbuffer(101, true, {-100.0f, -100.0f, 200.0f, 200.0f}, 1);
  Snapshot s = m.snapshot(1, 1).state;
  check(item(s, 1)->canvas_group.mode == grc::rs2::CanvasGroupMode::Transparent &&
            item(s, 1)->canvas_group.clear_margin == 10.0f && item(s, 1)->canvas_group.fit_empty &&
            item(s, 1)->canvas_group.fit_margin == 10.0f && item(s, 1)->canvas_group.blur_mipmaps &&
            item(s, 1)->content_version == 0,
        "set_canvas_group_mode: the whole state, content_version untouched");
  check(item(s, 2)->copy_to_backbuffer && item(s, 2)->copy_to_backbuffer_rect[2] == 200.0f &&
            item(s, 2)->content_version == 0,
        "set_copy_to_backbuffer: enabled with its rect, content_version untouched");
  m.set_canvas_group_mode(100, 4, 1.0f, false, 1.0f, false, 2);
  m.set_canvas_group_mode(100, -1, 1.0f, false, 1.0f, false, 2);
  m.clear(100, 2);
  m.clear(101, 2);
  s = m.snapshot(2, 2).state;
  check(item(s, 1)->canvas_group.mode == grc::rs2::CanvasGroupMode::Transparent &&
            item(s, 1)->canvas_group.fit_margin == 10.0f,
        "an out-of-range mode changes nothing; canvas_item_clear keeps the group");
  check(item(s, 2)->copy_to_backbuffer && item(s, 1)->content_version == 1,
        "canvas_item_clear keeps the copy (and bumps content_version as always)");
  m.set_canvas_group_mode(100, 1, 5.0f, false, 0.0f, false, 3);
  s = m.snapshot(3, 3).state;
  check(item(s, 1)->canvas_group.mode == grc::rs2::CanvasGroupMode::ClipOnly &&
            item(s, 1)->canvas_group.clear_margin == 5.0f && !item(s, 1)->canvas_group.fit_empty &&
            item(s, 1)->canvas_group.fit_margin == 0.0f && !item(s, 1)->canvas_group.blur_mipmaps,
        "a new mode replaces the whole group");
  m.set_canvas_group_mode(100, 0, 7.0f, true, 7.0f, true, 4);
  m.set_copy_to_backbuffer(101, false, {1.0f, 2.0f, 3.0f, 4.0f}, 4);
  s = m.snapshot(4, 4).state;
  const grc::rs2::CanvasGroupState none;
  check(item(s, 1)->canvas_group.mode == grc::rs2::CanvasGroupMode::Disabled &&
            item(s, 1)->canvas_group.clear_margin == none.clear_margin &&
            !item(s, 1)->canvas_group.fit_empty,
        "mode 0 clears the group, keeping none of the call's arguments");
  check(!item(s, 2)->copy_to_backbuffer && item(s, 2)->copy_to_backbuffer_rect[0] == 0.0f,
        "enable false clears the copy, keeping no rect");
  check(s.failures.empty(), "no failure from any of that");
  m.set_omit_op("canvas_item_set_canvas_group_mode", 5);
  m.set_canvas_group_mode(100, 2, 5.0f, false, 0.0f, false, 5);
  m.set_copy_to_backbuffer(101, true, {0.0f, 0.0f, 0.0f, 0.0f}, 5);
  s = m.snapshot(5, 5).state;
  check(item(s, 1)->canvas_group.mode == grc::rs2::CanvasGroupMode::Disabled &&
            item(s, 2)->copy_to_backbuffer,
        "omit-op canvas_item_set_canvas_group_mode drops only that setter");
  Mirror u;
  bind_root(&u);
  u.set_copy_to_backbuffer(0x999, true, {0.0f, 0.0f, 0.0f, 0.0f}, 1);
  check(!u.snapshot(1, 1).state.failures.empty(),
        "a copy on an item the mirror does not know is the unknown-RID rule");
}

// --- render-stream/11 (W11b; render-stream-11.md "Capture policy", WB) --------------------------

grc::rs::Mirror::V11Options v11_options(grc::rs2::MeshDynamicMode mode, int frames = 4,
                                        uint64_t max_bytes = 65536) {
  grc::rs::Mirror::V11Options o;
  o.enabled = true;
  o.mesh_dynamic.mode = mode;
  o.mesh_dynamic.frames = frames;
  o.mesh_dynamic.max_bytes = max_bytes;
  return o;
}

void update_vertices(Mirror *m, uint64_t rid, float x0, uint64_t frame) {
  const auto in = mesh_input(x0);
  m->mesh_surface_update_region(rid, "mesh_surface_update_vertex_region", 0, true, whole(in), frame);
}

// auto: the second change frame within K frames promotes; the creation frame and a byte-equal
// update are no change; a dynamic mesh stays dynamic; its body is the payload past header + meta.
void test_v11_mesh_classification() {
  using grc::rs2::MeshDynamicMode;
  Mirror m;
  bind_root(&m);
  m.set_v11(v11_options(MeshDynamicMode::Auto, 4));
  m.mesh_create(0x500, 1);
  m.mesh_add_surface(0x500, mesh_input(0), 1);  // the build frame: not a change
  update_vertices(&m, 0x500, 1, 1);              // still the build frame
  update_vertices(&m, 0x500, 2, 10);             // change frame 1
  update_vertices(&m, 0x500, 3, 10);             // the same frame: counted once
  check(!mesh(m.snapshot(1, 10).state, 1)->dynamic, "one change frame (10) is not dynamic");
  update_vertices(&m, 0x500, 3, 12);             // byte-equal: no change
  check(!mesh(m.snapshot(2, 12).state, 1)->dynamic, "a byte-equal update is no change");
  update_vertices(&m, 0x500, 4, 15);             // 15 - 10 > 4: a fresh first change
  check(!mesh(m.snapshot(3, 15).state, 1)->dynamic, "changes 5 frames apart stay static (K = 4)");
  update_vertices(&m, 0x500, 5, 19);             // 19 - 15 = 4 <= K
  grc::rs::Captured cap = m.snapshot(4, 19);
  const grc::rs2::MeshEntry *e = mesh(cap.state, 1);
  check(e->dynamic && e->surfaces.size() == 1 && e->surfaces[0].body != nullptr,
        "the second change within 4 frames makes it dynamic, with a body per surface");
  const auto in = mesh_input(5);
  const std::vector<uint8_t> &payload = *in.bytes;
  const uint32_t meta = payload[8] | (payload[9] << 8) | (payload[10] << 16) | (payload[11] << 24);
  check(e->surfaces[0].body->size() == payload.size() - 12 - meta &&
            std::equal(e->surfaces[0].body->begin(), e->surfaces[0].body->end(),
                       payload.begin() + 12 + meta),
        "the body is the GRM1 payload without its 12-byte header and its meta");
  check(e->surfaces[0].hash == in.copy.hash && e->surfaces[0].payload_bytes == payload.size() &&
            cap.payloads.count(in.copy.hash) == 1,
        "the snapshot keeps the GRM1 hash and payload (a /10 connection on a /11 host)");
  const uint64_t serial = e->content_serial;
  check(m.snapshot(5, 20).state.meshes[0].content_serial == serial,
        "no change, no serial move");
  for (uint64_t f = 30; f < 400; f += 50) {
    update_vertices(&m, 0x500, static_cast<float>(f), f);
  }
  const grc::rs2::MeshEntry later = mesh(m.snapshot(6, 400).state, 1) != nullptr
                                        ? *mesh(m.snapshot(7, 400).state, 1)
                                        : grc::rs2::MeshEntry();
  check(later.dynamic && later.content_serial > serial,
        "a dynamic mesh is never demoted, and every change moves its serial");
  m.mesh_clear(0x500, 401);
  const grc::rs2::MeshEntry *empty = mesh(m.snapshot(8, 401).state, 1);
  check(empty != nullptr && !empty->dynamic && empty->surfaces.empty(),
        "an empty mesh carries no dynamic flag (nothing to carry)");
  m.mesh_add_surface(0x500, mesh_input(9), 401);
  check(mesh(m.snapshot(9, 401).state, 1)->dynamic, "refilled, it is dynamic again");
}

// --- HC3 (host-cost-design.md D2): lazy mesh surfaces ------------------------------------------

// The vertex-region write the hook makes: the 8*n vertex bytes of `to` at the payload's data
// offset (12 + meta + 40), the AABB untouched. `to` must outlive the call.
grc::rs::MeshRegionWrite vertex_write(const grc::rs::MeshSurfaceInput &to) {
  const std::vector<uint8_t> &p = *to.bytes;
  const uint32_t meta = p[8] | (p[9] << 8) | (p[10] << 16) | (p[11] << 24);
  grc::rs::MeshRegionWrite w;
  w.offset = 12 + meta + 40;
  w.data = p.data() + w.offset;
  w.size = p.size() - w.offset;
  return w;
}

// `base`'s payload with `to`'s vertex bytes (what the engine's buffers hold after vertex_write).
std::vector<uint8_t> with_vertices(const grc::rs::MeshSurfaceInput &base,
                                   const grc::rs::MeshSurfaceInput &to) {
  std::vector<uint8_t> out = *base.bytes;
  const grc::rs::MeshRegionWrite w = vertex_write(to);
  std::memcpy(out.data() + w.offset, w.data, w.size);
  return out;
}

void test_hc3_lazy_mesh_surfaces() {
  using grc::rs2::MeshDynamicMode;
  // A /11 mirror nobody reads dynamic hashes from: keys, no SHA-256, copy-on-write payloads.
  Mirror m;
  bind_root(&m);
  m.set_v11(v11_options(MeshDynamicMode::All));
  m.set_dynamic_hash_readers(false);
  const auto a = mesh_input(0);
  const auto b = mesh_input(4);
  const auto c = mesh_input(9);
  m.mesh_create(0x500, 1);
  m.mesh_add_surface(0x500, a, 1);
  grc::rs::Captured s1 = m.snapshot(1, 1);
  const grc::rs2::MeshEntry *e = mesh(s1.state, 1);
  check(e != nullptr && e->dynamic && e->surfaces[0].hash_is_key &&
            e->surfaces[0].hash.rfind("hc3-key:", 0) == 0 && s1.keyed_surfaces,
        "HC3: a dynamic surface nobody hashes carries a payload key");
  check(s1.payloads.count(e->surfaces[0].hash) == 1 &&
            s1.payloads.at(e->surfaces[0].hash).get() == a.bytes.get() &&
            e->surfaces[0].payload_bytes == a.bytes->size() && e->surfaces[0].body != nullptr,
        "HC3: the key names the (shared) payload in the map; payload_bytes and body as before");
  check(m.stats().mesh_surface_hashes == 0 && m.stats().dynamic_surface_hashes == 0,
        "HC3: no SHA-256 for it");
  const std::string key1 = e->surfaces[0].hash;
  const uint64_t serial1 = e->content_serial;
  const uint64_t changes1 = m.stats().mesh_content_changes;

  // A byte-equal region write is no change: same key, same serial, no copy.
  const grc::rs::MeshRegionWrite same = vertex_write(a);
  m.mesh_surface_update_region(0x500, "mesh_surface_update_vertex_region", 0, true, &same, 2);
  grc::rs::Captured s2 = m.snapshot(2, 2);
  e = mesh(s2.state, 1);
  check(e->version == 3 && e->content_serial == serial1 && e->surfaces[0].hash == key1 &&
            m.stats().mesh_payload_copies == 0 && m.stats().mesh_content_changes == changes1,
        "HC3: a byte-equal write moves the version only (memcmp, no copy, same key)");

  // Two writes in one frame after a publication: one copy, one change, a new key, the published
  // buffer untouched.
  const grc::rs::MeshRegionWrite wb = vertex_write(b);
  const grc::rs::MeshRegionWrite wc = vertex_write(c);
  m.mesh_surface_update_region(0x500, "mesh_surface_update_vertex_region", 0, true, &wb, 3);
  m.mesh_surface_update_region(0x500, "mesh_surface_update_attribute_region", 0, true, &wc, 3);
  check(*s1.payloads.at(key1) == *a.bytes, "HC3: a published payload is never written (COW)");
  grc::rs::Captured s3 = m.snapshot(3, 3);
  e = mesh(s3.state, 1);
  const std::vector<uint8_t> want_c = with_vertices(a, c);
  check(m.stats().mesh_payload_copies == 1 && e->content_serial == serial1 + 2 &&
            e->surfaces[0].hash != key1 && *s3.payloads.at(e->surfaces[0].hash) == want_c,
        "HC3: two writes in a frame: one copy, a serial move each (as before), a new key over the new bytes");
  check(std::equal(e->surfaces[0].body->begin(), e->surfaces[0].body->end(),
                   want_c.begin() + (want_c.size() - e->surfaces[0].body->size())),
        "HC3: the body is the written payload's");

  // A reader (a viewer below /11, or the hook log): the SHA-256, computed once per content.
  m.set_dynamic_hash_readers(true);
  grc::rs::Captured s4 = m.snapshot(4, 4);
  e = mesh(s4.state, 1);
  const std::string sha_c = grc::sha256_hex(want_c.data(), want_c.size());
  check(!e->surfaces[0].hash_is_key && e->surfaces[0].hash == sha_c && !s4.keyed_surfaces &&
            s4.payloads.count(sha_c) == 1 && m.stats().dynamic_surface_hashes == 1,
        "HC3: with a reader the dynamic surface carries its SHA-256");
  m.snapshot(5, 5);
  check(m.stats().dynamic_surface_hashes == 1 && m.stats().mesh_surface_hashes == 1,
        "HC3: an unchanged surface is not hashed again");
  // make_patch at /11 across the reader's arrival and departure: a key against a hash of the
  // same content is no change; a real change is.
  {
    Snapshot base = s3.state;
    Snapshot cur = s4.state;
    base.version = grc::rs2::ProtocolVersion::V11;
    cur.version = grc::rs2::ProtocolVersion::V11;
    check(grc::rs2::make_patch(base, cur).meshes.empty() &&
              grc::rs2::make_patch(cur, base).meshes.empty(),
          "HC3: a keyed and a hashed snapshot of the same content patch nothing at /11");
    m.set_dynamic_hash_readers(false);
    const grc::rs::MeshRegionWrite wa = vertex_write(a);
    m.mesh_surface_update_region(0x500, "mesh_surface_update_vertex_region", 0, true, &wa, 6);
    Snapshot moved = m.snapshot(6, 6).state;
    moved.version = grc::rs2::ProtocolVersion::V11;
    check(grc::rs2::make_patch(cur, moved).meshes.size() == 1,
          "HC3: a changed dynamic mesh is patched against a hashed base");
  }

  // Static meshes (no /11): every region write of a frame is applied, the snapshot hashes once.
  Mirror st;
  bind_root(&st);
  st.set_dynamic_hash_readers(false);  // no effect below /11
  st.mesh_create(0x600, 1);
  st.mesh_add_surface(0x600, a, 1);
  st.snapshot(1, 1);
  check(st.stats().mesh_surface_hashes == 0, "HC3: the hook's creation hash is reused");
  st.mesh_surface_update_region(0x600, "mesh_surface_update_vertex_region", 0, true, &wb, 2);
  st.mesh_surface_update_region(0x600, "mesh_surface_update_vertex_region", 0, true, &wc, 2);
  grc::rs::Captured t2 = st.snapshot(2, 2);
  check(mesh(t2.state, 1)->surfaces[0].hash == sha_c && !mesh(t2.state, 1)->surfaces[0].hash_is_key &&
            st.stats().mesh_surface_hashes == 1 && st.stats().dynamic_surface_hashes == 0,
        "HC3: below /11 two writes in a frame cost one SHA-256, at the snapshot");

  // stale-dynamic hashes regardless (its patches compare them, as before HC3).
  Mirror sd;
  bind_root(&sd);
  auto o = v11_options(MeshDynamicMode::All);
  o.stale_dynamic_frame = 100;
  sd.set_v11(o);
  sd.set_dynamic_hash_readers(false);
  sd.mesh_create(0x700, 1);
  sd.mesh_add_surface(0x700, a, 1);
  check(!mesh(sd.snapshot(1, 1).state, 1)->surfaces[0].hash_is_key,
        "HC3: stale-dynamic always hashes");

  // perturb-vertex: starting at an update is a change even when its bytes are equal, and the
  // published bytes (and hash) are the perturbed copy; the true bytes are kept for the next write.
  Mirror pv;
  bind_root(&pv);
  pv.set_v11(v11_options(MeshDynamicMode::All));
  pv.set_perturb_vertex(10);
  pv.mesh_create(0x800, 1);
  pv.mesh_add_surface(0x800, a, 1);
  const uint64_t pserial = mesh(pv.snapshot(1, 1).state, 1)->content_serial;
  pv.mesh_surface_update_region(0x800, "mesh_surface_update_vertex_region", 0, true, &same, 10);
  grc::rs::Captured p2 = pv.snapshot(2, 10);
  const auto *pe = mesh(p2.state, 1);
  std::vector<uint8_t> perturbed = *a.bytes;
  {
    const grc::rs::MeshRegionWrite w = vertex_write(a);
    float x = 0;
    std::memcpy(&x, perturbed.data() + w.offset, 4);
    x += 1.0f;
    std::memcpy(perturbed.data() + w.offset, &x, 4);
  }
  check(pe->content_serial == pserial + 1 &&
            pe->surfaces[0].hash == grc::sha256_hex(perturbed.data(), perturbed.size()) &&
            *p2.payloads.at(pe->surfaces[0].hash) == perturbed,
        "HC3 perturb-vertex: an equal write at the frame is a change to the perturbed copy");
  pv.mesh_surface_update_region(0x800, "mesh_surface_update_vertex_region", 0, true, &same, 11);
  check(mesh(pv.snapshot(3, 11).state, 1)->content_serial == pserial + 1,
        "HC3 perturb-vertex: once perturbed, an equal write is no change");
}

void test_v11_mesh_modes() {
  using grc::rs2::MeshDynamicMode;
  {
    Mirror m;
    bind_root(&m);
    m.set_v11(v11_options(MeshDynamicMode::All));
    m.mesh_create(0x500, 1);
    check(!mesh(m.snapshot(1, 1).state, 1)->dynamic, "all: an empty mesh is not dynamic");
    m.mesh_add_surface(0x500, mesh_input(0), 1);
    check(mesh(m.snapshot(2, 1).state, 1)->dynamic, "all: dynamic at its first content");
  }
  {
    Mirror m;
    bind_root(&m);
    m.set_v11(v11_options(MeshDynamicMode::Off));
    m.mesh_create(0x500, 1);
    m.mesh_add_surface(0x500, mesh_input(0), 1);
    for (uint64_t f = 2; f < 10; ++f) {
      update_vertices(&m, 0x500, static_cast<float>(f), f);
    }
    check(!mesh(m.snapshot(1, 10).state, 1)->dynamic, "off: never dynamic");
  }
  {
    Mirror m;
    bind_root(&m);
    m.set_v11(v11_options(MeshDynamicMode::Auto, 4, 10));  // a 3-vertex body is 64 bytes
    m.mesh_create(0x500, 1);
    m.mesh_add_surface(0x500, mesh_input(0), 1);
    update_vertices(&m, 0x500, 1, 2);
    update_vertices(&m, 0x500, 2, 3);
    check(!mesh(m.snapshot(1, 3).state, 1)->dynamic, "a mesh over max_bytes stays static");
  }
  {
    Mirror m;  // V11Options off: the snapshot is /10's
    bind_root(&m);
    m.mesh_create(0x500, 1);
    m.mesh_add_surface(0x500, mesh_input(0), 1);
    update_vertices(&m, 0x500, 1, 2);
    update_vertices(&m, 0x500, 2, 3);
    const grc::rs2::MeshEntry *e = mesh(m.snapshot(1, 3).state, 1);
    check(!e->dynamic && e->content_serial == 0 && e->surfaces[0].body == nullptr,
          "disabled: no dynamic flag, serial or body");
  }
  {
    Mirror m;  // stale-dynamic: the first dynamic mesh changing from frame 6 keeps its serial
    bind_root(&m);
    grc::rs::Mirror::V11Options o = v11_options(MeshDynamicMode::All);
    o.stale_dynamic_frame = 6;
    m.set_v11(o);
    m.mesh_create(0x500, 1);
    m.mesh_add_surface(0x500, mesh_input(0), 1);
    m.mesh_create(0x600, 1);
    m.mesh_add_surface(0x600, mesh_input(0), 1);
    const uint64_t s1 = mesh(m.snapshot(1, 1).state, 1)->content_serial;
    const uint64_t s2 = mesh(m.snapshot(2, 1).state, 2)->content_serial;
    update_vertices(&m, 0x500, 5, 5);
    update_vertices(&m, 0x500, 6, 6);
    update_vertices(&m, 0x600, 7, 7);
    const Snapshot snap = m.snapshot(3, 7).state;
    check(mesh(snap, 1)->content_serial == s1 + 1 && mesh(snap, 2)->content_serial == s2 + 1,
          "stale-dynamic: mesh 1 froze at its frame-6 change, mesh 2 still moves");
  }
}

// WB's stable content_version: equal command lists carry equal versions, whatever lies between.
void test_v11_stable_content_version() {
  using grc::rs2::MeshDynamicMode;
  const auto draw = [](Mirror *m, const grc::rs2::Color4 &color, uint64_t frame) {
    m->clear(100, frame);
    m->add_rect(100, kRect, color, false, frame);
  };
  Mirror m;
  bind_root(&m);
  m.set_v11(v11_options(MeshDynamicMode::Auto));
  m.canvas_item_create(100, 1);
  draw(&m, kRed, 1);
  const uint64_t red = item(m.snapshot(1, 1).state, 1)->content_version;
  check(red != 0 && red < (uint64_t{1} << 53), "a 53-bit content_version");
  draw(&m, kRed, 2);
  check(item(m.snapshot(2, 2).state, 1)->content_version == red,
        "an identical re-record keeps content_version");
  draw(&m, kGreen, 3);
  const uint64_t green = item(m.snapshot(3, 3).state, 1)->content_version;
  check(green != red, "a different list moves it");
  draw(&m, kRed, 4);
  check(item(m.snapshot(4, 4).state, 1)->content_version == red,
        "back to the first list (A-B-A): the first version again, so any base agrees");
  grc::rs2::Color4 nz = kRed;
  nz[0] = -0.0f;
  grc::rs2::Color4 pz = kRed;
  pz[0] = 0.0f;
  draw(&m, nz, 5);
  const uint64_t neg = item(m.snapshot(5, 5).state, 1)->content_version;
  draw(&m, pz, 6);
  check(item(m.snapshot(6, 6).state, 1)->content_version != neg,
        "floats compare by bit pattern (-0 and +0 differ)");

  Mirror churn;
  bind_root(&churn);
  grc::rs::Mirror::V11Options o = v11_options(MeshDynamicMode::Auto);
  o.cv_churn = true;
  churn.set_v11(o);
  churn.canvas_item_create(100, 1);
  draw(&churn, kRed, 1);
  const uint64_t a = item(churn.snapshot(1, 1).state, 1)->content_version;
  draw(&churn, kRed, 2);
  check(item(churn.snapshot(2, 2).state, 1)->content_version == a + 2,
        "cv-churn: the counter moves on every re-record, as below /11");
}

// HC2 (host-cost-design.md D1): the mirror's command lists are shared with its snapshots; a /11
// identical re-record publishes the published list again with no digest; any other change, and
// every re-record below /11, publishes the new list.
void test_hc2_shared_command_lists() {
  using grc::rs2::MeshDynamicMode;
  const auto draw = [](Mirror *m, const grc::rs2::Color4 &color, uint64_t frame) {
    m->clear(100, frame);
    m->add_rect(100, kRect, color, false, frame);
  };
  {
    Mirror m;  // below /11
    bind_root(&m);
    m.canvas_item_create(100, 1);
    draw(&m, kRed, 1);
    const Snapshot s1 = m.snapshot(1, 1).state;
    const Snapshot s2 = m.snapshot(2, 2).state;
    check(item(s2, 1)->commands.shares(item(s1, 1)->commands),
          "share: an unchanged item's commands are one list in every snapshot");
    m.add_rect(100, kRect, kGreen, false, 3);
    const Snapshot s3 = m.snapshot(3, 3).state;
    check(item(s3, 1)->commands.size() == 2 && item(s2, 1)->commands.size() == 1 &&
              item(s1, 1)->commands.shares(item(s2, 1)->commands),
          "divergence: appending after a snapshot leaves the published list untouched");
    draw(&m, kRed, 4);
    draw(&m, kRed, 4);
    const Snapshot s4 = m.snapshot(4, 4).state;
    check(item(s4, 1)->commands.size() == 1 && item(s3, 1)->commands.size() == 2 &&
              !item(s4, 1)->commands.shares(item(s1, 1)->commands) &&
              item(s4, 1)->content_version != item(s1, 1)->content_version,
          "below /11 an identical re-record is still a change (the counter is the wire's)");
    check(m.stats().cv_digests == 0 && m.stats().cv_rerecords_kept == 0,
          "below /11 no digest is made");
  }
  {
    Mirror m;  // /11
    bind_root(&m);
    m.set_v11(v11_options(MeshDynamicMode::Auto));
    m.canvas_item_create(100, 1);
    draw(&m, kRed, 1);
    const Snapshot s1 = m.snapshot(1, 1).state;
    check(m.stats().cv_digests == 1 && m.stats().cv_rerecords_kept == 0, "first publication: a digest");
    draw(&m, kRed, 2);
    const Snapshot s2 = m.snapshot(2, 2).state;
    check(item(s2, 1)->commands.shares(item(s1, 1)->commands) &&
              item(s2, 1)->content_version == item(s1, 1)->content_version &&
              m.stats().cv_digests == 1 && m.stats().cv_rerecords_kept == 1,
          "re-record equal: the published list and digest are kept, no new digest");
    check(grc::rs2::make_patch(s1, s2).items.empty(), "re-record equal: no patch entry");
    grc::rs2::Color4 nudged = kRed;
    nudged[2] = 1e-6f;
    draw(&m, nudged, 3);
    const Snapshot s3 = m.snapshot(3, 3).state;
    check(!item(s3, 1)->commands.shares(item(s2, 1)->commands) &&
              item(s3, 1)->commands[0].color[2] == 1e-6f &&
              item(s3, 1)->content_version != item(s2, 1)->content_version &&
              m.stats().cv_digests == 2,
          "re-record unequal (one float): the new list and a new digest");
    const grc::rs2::Transaction t = grc::rs2::make_patch(s2, s3);
    check(t.items.size() == 1 && !t.items[0].commands_null, "re-record unequal: patched with its list");
    draw(&m, kRed, 4);
    draw(&m, nudged, 4);
    const Snapshot s4 = m.snapshot(4, 4).state;
    check(item(s4, 1)->commands.shares(item(s3, 1)->commands) && m.stats().cv_rerecords_kept == 2,
          "two re-records in one frame ending equal to the published list: kept");
    draw(&m, kRed, 5);
    const Snapshot s5 = m.snapshot(5, 5).state;
    check(item(s5, 1)->content_version == item(s1, 1)->content_version && m.stats().cv_digests == 3,
          "back to the first list (A-B-A): digested again, the first version again");
  }
  {
    Mirror m;  // the rerecord-stale sabotage
    bind_root(&m);
    grc::rs::Mirror::V11Options o = v11_options(MeshDynamicMode::Auto);
    o.rerecord_stale = true;
    m.set_v11(o);
    m.canvas_item_create(100, 1);
    draw(&m, kRed, 1);
    const Snapshot s1 = m.snapshot(1, 1).state;
    draw(&m, kGreen, 2);
    const Snapshot s2 = m.snapshot(2, 2).state;
    check(item(s2, 1)->commands.shares(item(s1, 1)->commands) &&
              item(s2, 1)->commands[0].color == kRed,
          "rerecord-stale: a list differing only in floats keeps the stale one");
  }
}

// --- PM1: multimeshes (render-stream-11.md "As built (PM1): decisions") -----------------------

grc::rs::Mirror::MultimeshOptions mm_options(uint64_t max_payload = 1u << 20,
                                             uint64_t stale_frame = 0) {
  grc::rs::Mirror::MultimeshOptions o;
  o.enabled = true;
  o.max_payload_bytes = max_payload;
  o.stale_buffer_frame = stale_frame;
  o.state_notes = true;
  return o;
}

const grc::rs2::MultimeshEntry *mm_entry(const Snapshot &s, uint32_t id) {
  for (const auto &m : s.multimeshes) {
    if (m.id == id) return &m;
  }
  return nullptr;
}

// A /11 mirror with item 100 (rid 100), mesh 1 (rid 0x500) and multimesh 1 (rid 0x700) allocated
// with `instances` 2d instances, colours and custom data, drawn by item 100.
void mm_scene(Mirror *m, const grc::rs::Mirror::MultimeshOptions &options = mm_options()) {
  bind_root(m);
  m->set_v11(v11_options(grc::rs2::MeshDynamicMode::Auto));
  m->set_multimesh(options);
  m->canvas_item_create(100, 1);
  m->mesh_create(0x500, 1);
  m->multimesh_create(0x700, 1);
  m->multimesh_allocate_data(0x700, 2, 0, true, true, false, 1);
  m->add_multimesh(100, 0x700, 0, 1);
}

std::vector<float> ramp(std::size_t n, float base) {
  std::vector<float> out(n);
  for (std::size_t i = 0; i < n; ++i) {
    out[i] = base + static_cast<float>(i);
  }
  return out;
}

// allocate zeros the shadow, set_buffer replaces it (an equal one changes nothing), the setters
// patch set_buffer's layout, refused calls change nothing; version and serial follow rule 2.
void test_multimesh_shadow_and_versions() {
  using grc::rs2::MultimeshStatus;
  Mirror m;
  mm_scene(&m);
  grc::rs::Captured c1 = m.snapshot(1, 1);
  const auto *e = mm_entry(c1.state, 1);
  check(e != nullptr && e->status == MultimeshStatus::Ok && e->version == 2 &&
            e->instances == 2 && e->colors && e->custom && e->visible == -1 && !e->has_mesh,
        "create (1) + allocate (2): ok, 2 instances, visible -1, no mesh");
  check(e != nullptr && e->buffer != nullptr && e->buffer->size() == 32 &&
            std::all_of(e->buffer->begin(), e->buffer->end(), [](float v) { return v == 0.0f; }),
        "allocate: a zero buffer of instances x stride (2 x 16)");
  const uint64_t serial1 = e != nullptr ? e->buffer_serial : 0;
  check(c1.state.multimesh_commands, "a snapshot with an add_multimesh is flagged for lowering");

  const std::vector<float> zeros(32, 0.0f);
  auto r = m.multimesh_set_buffer(0x700, zeros.data(), zeros.size(), 2);
  check(r.known && r.id == 1 && r.accepted && !r.changed && r.version == 2,
        "set_buffer with the shadow's own floats: accepted, nothing moves");
  const std::vector<float> b = ramp(32, 1.0f);
  r = m.multimesh_set_buffer(0x700, b.data(), b.size(), 2);
  check(r.accepted && r.changed && r.version == 3, "a new buffer: version 3");
  r = m.multimesh_set_buffer(0x700, b.data(), 31, 2);
  check(!r.accepted && !r.changed && r.version == 3, "a size-mismatched set_buffer is refused");
  grc::rs::Captured c2 = m.snapshot(2, 2);
  e = mm_entry(c2.state, 1);
  check(e != nullptr && *e->buffer == b && e->buffer_serial != serial1,
        "the shadow holds the new floats; the serial moved");
  const uint64_t serial2 = e != nullptr ? e->buffer_serial : 0;
  r = m.multimesh_set_buffer(0x700, b.data(), b.size(), 3);
  check(r.accepted && !r.changed, "the same buffer again (an idle emitter) moves nothing");
  const grc::rs::Captured c3 = m.snapshot(3, 3);
  check(mm_entry(c3.state, 1)->buffer_serial == serial2, "nor the serial");

  // Setters: GLES3's 2d layout [xx, yx, 0, ox, xy, yy, 0, oy], colour at 8, custom at 12.
  const Xform t = {1.5f, 2.5f, 3.5f, 4.5f, 5.5f, 6.5f};
  r = m.multimesh_instance_set_transform_2d(0x700, 1, t, 4);
  check(r.accepted && r.changed && r.version == 4, "set_transform_2d: version 4");
  r = m.multimesh_instance_set_transform_2d(0x700, 1, t, 4);
  check(r.accepted && !r.changed, "the same transform again changes nothing");
  check(!m.multimesh_instance_set_transform_2d(0x700, 2, t, 4).accepted,
        "an index out of range is refused");
  check(!m.multimesh_instance_set_transform(0x700, 0, {}, 4).accepted,
        "a 3d transform on a 2d multimesh is refused");
  r = m.multimesh_instance_set_color(0x700, 0, {0.1f, 0.2f, 0.3f, 0.4f}, 4);
  check(r.accepted && r.changed && r.version == 5, "set_color: version 5");
  r = m.multimesh_instance_set_custom_data(0x700, 0, {0.5f, 0.6f, 0.7f, 0.8f}, 4);
  check(r.accepted && r.changed && r.version == 6, "set_custom_data: version 6");
  const grc::rs::Captured c4 = m.snapshot(4, 4);
  e = mm_entry(c4.state, 1);
  const std::vector<float> &s = *e->buffer;
  check(s[16] == 1.5f && s[17] == 3.5f && s[18] == 0.0f && s[19] == 5.5f && s[20] == 2.5f &&
            s[21] == 4.5f && s[22] == 0.0f && s[23] == 6.5f,
        "instance 1's transform is [xx, yx, 0, ox, xy, yy, 0, oy]");
  check(s[8] == 0.1f && s[11] == 0.4f && s[12] == 0.5f && s[15] == 0.8f && s[24] == b[24],
        "instance 0's colour at 8, custom at 12; instance 1's colour untouched");

  // visible, custom AABB, mesh: new values only.
  check(!m.multimesh_set_visible_instances(0x700, 3, 5).accepted, "visible > instances refused");
  check(!m.multimesh_set_visible_instances(0x700, -2, 5).accepted, "visible < -1 refused");
  check(m.multimesh_set_visible_instances(0x700, 1, 5).changed, "visible 1 is new");
  check(!m.multimesh_set_visible_instances(0x700, 1, 5).changed, "visible 1 again is not");
  check(!m.multimesh_set_custom_aabb(0x700, {0, 0, 0, 0, 0, 0}, 5).changed,
        "the zero AABB is the current one");
  check(m.multimesh_set_custom_aabb(0x700, {-1, -1, 0, 4, 4, 0}, 5).changed, "a new custom AABB");
  check(!m.multimesh_set_mesh(0x700, 0, 5).changed, "set_mesh(RID()) changes nothing (GLES3)");
  r = m.multimesh_set_mesh(0x700, 0x500, 5);
  check(r.changed && r.version == 9, "set_mesh: version 9");
  check(!m.multimesh_set_mesh(0x700, 0x500, 5).changed, "the same mesh again changes nothing");
  const grc::rs::Captured c5 = m.snapshot(5, 5);
  e = mm_entry(c5.state, 1);
  check(e->has_mesh && e->mesh == 1 && e->visible == 1 && e->custom_aabb[3] == 4.0f &&
            e->version == 9,
        "mesh 1, visible 1, the custom AABB, version 9");

  // A re-allocate: a new shape zeros the buffer and clamps visible (MIN, -1 stays -1).
  r = m.multimesh_allocate_data(0x700, 0, 0, true, true, false, 6);
  check(r.accepted && r.changed, "allocate to 0 instances");
  const grc::rs::Captured c6 = m.snapshot(6, 6);
  e = mm_entry(c6.state, 1);
  check(e->instances == 0 && e->visible == 0 && e->buffer->empty() && e->custom_aabb[3] == 4.0f,
        "0 instances: visible clamped to 0, an empty buffer, the custom AABB kept");
  const uint64_t version = e->version;
  r = m.multimesh_allocate_data(0x700, 0, 0, true, true, false, 7);
  check(r.accepted && r.changed && r.version == version + 1,
        "an identical allocate is accepted and moves the version (rule 2: allocate always)");
  check(!m.multimesh_allocate_data(0x700, -1, 0, false, false, false, 7).accepted,
        "a negative instance count is refused");
  check(!m.multimesh_allocate_data(0x700, 1, 2, false, false, false, 7).accepted,
        "an unknown transform format is refused");
  check(!m.multimesh_set_buffer(0x999, b.data(), b.size(), 7).known,
        "a multimesh tap on an unknown RID is not known");
  check(m.stats().multimesh_unknown == 1 && m.stats().live_multimeshes == 1, "stats");
}

// Rule 2's reasons, and add_multimesh's derived item-level entries (rule 7).
void test_multimesh_reasons() {
  using grc::rs2::MultimeshReason;
  using grc::rs2::MultimeshStatus;
  Mirror m;
  mm_scene(&m);
  const auto status = [&m](uint64_t frame) {
    return *mm_entry(m.snapshot(frame, frame).state, 1);
  };
  m.multimesh_allocate_data(0x700, 2, 1, false, false, false, 2);
  auto e = status(2);
  check(e.status == MultimeshStatus::Unsupported && e.reason == MultimeshReason::Multimesh3d &&
            e.format == grc::rs2::MultimeshFormat::ThreeD && e.buffer == nullptr,
        "TRANSFORM_3D: multimesh-3d, no buffer");
  check(m.multimesh_instance_set_transform(0x700, 1, {}, 2).accepted,
        "a 3d multimesh takes 3d transforms");
  const std::vector<Entry> entries = item_entries(m.snapshot(3, 3).state);
  check(std::find(entries.begin(), entries.end(),
                  Entry{1, "canvas_item_add_multimesh", UnsupportedReason::UnsupportedMultimesh}) !=
            entries.end(),
        "an add_multimesh naming an unsupported multimesh: unsupported-multimesh");
  m.multimesh_allocate_data(0x700, 2, 0, false, false, true, 4);
  check(status(4).reason == MultimeshReason::MultimeshIndirect, "use_indirect: multimesh-indirect");
  m.multimesh_allocate_data(0x700, 2, 0, false, false, false, 5);
  check(status(5).status == MultimeshStatus::Ok, "re-allocated 2d: ok again");
  m.multimesh_set_physics_interpolated(0x700, true, 6);
  check(status(6).reason == MultimeshReason::MultimeshInterpolated,
        "set_physics_interpolated(true): multimesh-interpolated");
  m.multimesh_set_physics_interpolated(0x700, false, 7);
  check(status(7).status == MultimeshStatus::Ok, "and back off: ok");
  const std::vector<float> b(16, 1.0f);
  check(m.multimesh_set_buffer_interpolated(0x700, b.data(), 16, 16, 8).changed,
        "set_buffer_interpolated always moves the version");
  check(!m.multimesh_set_buffer_interpolated(0x700, b.data(), 16, 15, 8).accepted,
        "a previous buffer of the wrong size is refused");
  check(status(8).reason == MultimeshReason::MultimeshInterpolated,
        "set_buffer_interpolated: multimesh-interpolated ...");
  m.multimesh_allocate_data(0x700, 2, 0, false, false, false, 9);
  check(status(9).status == MultimeshStatus::Ok, "... until a re-allocate");
  m.multimesh_set_mesh(0x700, 0x999, 10);
  e = status(10);
  check(e.reason == MultimeshReason::UnknownMesh && !e.has_mesh,
        "set_mesh on a mesh never seen: unknown-mesh, mesh null");
  m.multimesh_set_mesh(0x700, 0x500, 11);
  e = status(11);
  check(e.status == MultimeshStatus::Ok && e.has_mesh && e.mesh == 1, "a valid set_mesh: ok");

  Mirror small;
  mm_scene(&small, mm_options(64));  // 64 bytes: 1 instance of stride 16 fits, 2 do not
  e = *mm_entry(small.snapshot(1, 1).state, 1);
  check(e.reason == MultimeshReason::PayloadTooLarge && e.buffer == nullptr,
        "2 x 16 floats (128 B) over max_payload_bytes 64: payload-too-large");
  check(small.multimesh_set_buffer(0x700, ramp(32, 0).data(), 32, 2).changed,
        "without a shadow every accepted set_buffer moves the version");
  small.multimesh_allocate_data(0x700, 1, 0, true, true, false, 3);
  const grc::rs::Captured s3 = small.snapshot(3, 3);
  check(mm_entry(s3.state, 1)->status == MultimeshStatus::Ok,
        "1 x 16 floats (64 B): ok");

  // add_multimesh on a RID the mirror never saw created.
  Mirror u;
  mm_scene(&u);
  u.add_multimesh(100, 0x888, 0, 2);
  const Snapshot su = u.snapshot(2, 2).state;
  const auto &cmd = item(su, 1)->commands.back();
  check(cmd.kind == CommandKind::Unsupported && cmd.name == "canvas_item_add_multimesh" &&
            cmd.unsupported_reason == grc::rs2::UnsupportedCmdReason::UnknownMultimesh,
        "an unknown multimesh RID: unsupported / unknown-multimesh");
  const std::vector<Entry> ue = item_entries(su);
  check(ue.size() == 1 &&
            ue[0] == Entry{1, "canvas_item_add_multimesh", UnsupportedReason::UnknownMultimesh},
        "one derived unknown-multimesh entry");
}

// Rule 9: published when named; a freed multimesh is a tombstone while named, then leaves; its
// mesh keeps the mesh's tombstone (rule 6). And the state notes (rule 12).
void test_multimesh_publication_and_free() {
  using grc::rs2::MultimeshStatus;
  Mirror m;
  mm_scene(&m);
  m.multimesh_create(0x701, 1);  // never drawn
  m.multimesh_set_mesh(0x700, 0x500, 1);
  grc::rs::Captured c1 = m.snapshot(1, 1);
  check(c1.state.multimeshes.size() == 1 && c1.state.multimeshes[0].id == 1,
        "only the multimesh an add_multimesh names is in the table");
  auto notes = m.take_multimesh_states();
  check(notes.size() == 2 && notes[0].frame == 1 && notes[0].entry.id == 1 &&
            notes[0].entry.version == 3 && notes[1].entry.id == 2 && notes[1].rid == 0x701,
        "a state note per multimesh whose version moved, at the snapshot's frame");
  m.snapshot(2, 2);
  check(m.take_multimesh_states().empty(), "no version moved: no note");

  m.free_rid(0x500, 3);  // the mesh: its tombstone stays, a multimesh names it
  grc::rs::Captured c3 = m.snapshot(3, 3);
  check(mesh(c3.state, 1) != nullptr &&
            mesh(c3.state, 1)->status == grc::rs2::MeshStatus::Freed &&
            mm_entry(c3.state, 1)->has_mesh,
        "a freed mesh a multimesh names stays a tombstone (multimesh-ref)");
  auto r = m.multimesh_free(0x700, 4);
  check(r.accepted && r.changed && r.version == 4, "free: version + 1");
  check(!m.knows_multimesh(0x700), "the RID is forgotten");
  grc::rs::Captured c4 = m.snapshot(4, 4);
  const auto *e = mm_entry(c4.state, 1);
  check(e != nullptr && e->status == MultimeshStatus::Freed && e->version == 4 && !e->has_mesh &&
            e->instances == 0 && e->visible == -1 && !e->colors && !e->custom &&
            e->buffer == nullptr,
        "a named freed multimesh is a tombstone (rule 2's shape)");
  check(item_entries(c4.state).empty(), "a tombstone is not unsupported");
  notes = m.take_multimesh_states();
  check(notes.size() == 1 && notes[0].entry.status == MultimeshStatus::Freed && notes[0].rid == 0,
        "the free's note");
  m.clear(100, 5);
  grc::rs::Captured c5 = m.snapshot(5, 5);
  check(c5.state.multimeshes.empty() && m.stats().live_multimeshes == 1 &&
            !c5.state.multimesh_commands,
        "unnamed, the tombstone leaves (the never-drawn multimesh stays in the mirror)");
  m.free_rid(0x701, 6);
  notes = m.take_multimesh_states();
  check(notes.size() == 1 && notes[0].entry.id == 2 && notes[0].frame == 6 &&
            m.stats().live_multimeshes == 0,
        "free_rid of an unnamed multimesh: gone at once, with its last note");
  m.snapshot(6, 6);
  check(m.take_multimesh_states().empty(), "and noted once");
}

// stale-buffer (rule 11): the first multimesh whose buffer changes at or after the frame keeps
// its serial, so make_patch leaves buffer_f null over new floats.
void test_multimesh_stale_buffer_and_patch() {
  Mirror m;
  mm_scene(&m, mm_options(1u << 20, 3));
  grc::rs::Captured b = m.snapshot(1, 1);
  b.state.version = grc::rs2::ProtocolVersion::V11;
  const std::vector<float> f2 = ramp(32, 2.0f);
  m.multimesh_set_buffer(0x700, f2.data(), f2.size(), 2);
  grc::rs::Captured t = m.snapshot(2, 2);
  t.state.version = grc::rs2::ProtocolVersion::V11;
  grc::rs2::Transaction p = grc::rs2::make_patch(b.state, t.state);
  check(p.multimeshes.size() == 1 && p.multimesh_buffers_held.empty(),
        "before the frame a buffer change writes its floats");
  const grc::rs2::Transaction same = grc::rs2::make_patch(t.state, t.state);
  check(same.multimeshes.empty() && same.removed_multimeshes.empty(),
        "a repeated target (stale-coalesce): no entry, no floats");
  const std::vector<float> f3 = ramp(32, 3.0f);
  m.multimesh_set_buffer(0x700, f3.data(), f3.size(), 3);
  grc::rs::Captured t3 = m.snapshot(3, 3);
  t3.state.version = grc::rs2::ProtocolVersion::V11;
  p = grc::rs2::make_patch(t.state, t3.state);
  check(p.multimeshes.size() == 1 && p.multimesh_buffers_held.size() == 1,
        "stale-buffer: the entry moves (version) but its buffer_f stays null");
}

// Rule 7 below /11: a /10 connection of a /11 host sees exactly what it saw before PM1 (the
// hooks' unsupported-op command, its entry, its content_version, no table).
void test_multimesh_lowered_below_v11() {
  Mirror with;
  mm_scene(&with);
  with.multimesh_allocate_data(0x700, 2, 1, false, false, false, 1);  // unsupported: 3d
  with.add_multimesh(100, 0x888, 0, 1);                                // unknown
  Mirror without;
  bind_root(&without);
  without.set_v11(v11_options(grc::rs2::MeshDynamicMode::Auto));
  without.canvas_item_create(100, 1);
  without.mesh_create(0x500, 1);
  without.add_unsupported(100, "canvas_item_add_multimesh", 1);
  without.add_unsupported(100, "canvas_item_add_multimesh", 1);
  Snapshot a = with.snapshot(1, 1).state;
  Snapshot b = without.snapshot(1, 1).state;
  check(item(a, 1)->content_version != item(b, 1)->content_version &&
            item(a, 1)->content_version_below_v11 == item(b, 1)->content_version,
        "the /11 digest differs; the below-/11 digest is the pre-PM1 one");
  a.version = b.version = grc::rs2::ProtocolVersion::V10;
  check(grc::rs2::encode_transaction(grc::rs2::make_full(a)) ==
            grc::rs2::encode_transaction(grc::rs2::make_full(b)),
        "a /10 full transaction of a /11 host with multimeshes is the pre-PM1 one");
  Snapshot a0 = a;
  Snapshot b0 = b;
  with.clear(100, 2);
  with.add_rect(100, kRect, kRed, false, 2);
  without.clear(100, 2);
  without.add_rect(100, kRect, kRed, false, 2);
  Snapshot a2 = with.snapshot(2, 2).state;
  Snapshot b2 = without.snapshot(2, 2).state;
  a2.version = b2.version = grc::rs2::ProtocolVersion::V10;
  check(grc::rs2::encode_transaction(grc::rs2::make_patch(a0, a2)) ==
            grc::rs2::encode_transaction(grc::rs2::make_patch(b0, b2)),
        "and so is a /10 patch");
}

// HC1: a set_material that sets the item's current material is no assignment at all: the
// adoption epoch stays, a different material (or a cleared one coming back) moves it.
void test_same_value_set_material_keeps_epoch() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.canvas_item_create(101, 1);
  m.material_create(0x700, 1);
  m.material_create(0x701, 1);
  m.set_material(100, 0x700, 1);
  std::uint64_t epoch = m.material_refs_epoch();
  m.set_material(100, 0x700, 2);
  m.set_material(100, 0x700, 3);
  check(m.material_refs_epoch() == epoch, "the same known material again leaves the epoch");
  m.set_material(101, 0x700, 3);
  check(m.material_refs_epoch() == epoch + 1, "another item taking it is an assignment");
  epoch = m.material_refs_epoch();
  m.set_material(100, 0x701, 4);
  check(m.material_refs_epoch() == epoch + 1, "a different material moves the epoch");
  epoch = m.material_refs_epoch();
  m.set_material(100, 0, 5);
  m.set_material(100, 0x701, 6);
  check(m.material_refs_epoch() == epoch + 1, "null then the old material is a new assignment");
  epoch = m.material_refs_epoch();
  m.set_material(100, 0x999, 7);  // unknown RID
  check(m.material_refs_epoch() == epoch + 1, "an unknown material is an assignment");
  epoch = m.material_refs_epoch();
  m.set_material(100, 0x999, 8);
  check(m.material_refs_epoch() == epoch, "the same unknown RID again leaves the epoch");
  Snapshot s = m.snapshot(1, 1).state;
  check(has_material_entry(s, 1) && !item(s, 1)->has_material,
        "and the item still names an unknown material");
}

// --- PM5: particles (render-stream-12.md "Particles table", "The emit list", builtin) ---------

grc::rs::Mirror::ParticlesOptions pt_options(uint64_t drop_restart = 0) {
  grc::rs::Mirror::ParticlesOptions o;
  o.enabled = true;
  o.state_notes = true;
  o.drop_restart_frame = drop_restart;
  o.param_arrays = true;
  return o;
}

const grc::rs2::ParticlesEntry *pt_entry(const Snapshot &s, uint32_t id) {
  for (const auto &p : s.particles) {
    if (p.id == id) return &p;
  }
  return nullptr;
}

using PtOp = grc::rs::Mirror::ParticlesOp;

grc::rs::Mirror::ParticlesArgs pt_i(int64_t v, uint64_t rid = 0) {
  grc::rs::Mirror::ParticlesArgs a;
  a.i = v;
  a.rid = rid;
  return a;
}

grc::rs::Mirror::ParticlesArgs pt_f(std::vector<float> f) {
  grc::rs::Mirror::ParticlesArgs a;
  a.f = std::move(f);
  return a;
}

// A /12 mirror: item 100 (rid 100) drawing emitter 1 (rid 0x900), mode 2d, with mesh 1 (0x500).
void pt_scene(Mirror *m, const grc::rs::Mirror::ParticlesOptions &options = pt_options()) {
  bind_root(m);
  m->set_v11(v11_options(grc::rs2::MeshDynamicMode::Auto));
  m->set_multimesh(mm_options());
  m->set_particles(options);
  m->canvas_item_create(100, 1);
  m->mesh_create(0x500, 1);
  m->particles_create(0x900, 1);
  m->particles_call(0x900, PtOp::SetMode, pt_i(0), 1);
  m->add_particles(100, 0x900, 0, 1);
}

// "As built (PM5)" rule 4: bind poses set while trails are off are kept but not carried.
void test_particles_trail_poses_need_trails() {
  Mirror m;
  pt_scene(&m);
  std::vector<float> pose = {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -4, 0};
  m.particles_call(0x900, PtOp::SetTrailBindPoses, pt_f(pose), 1);
  Snapshot s1 = m.snapshot(1, 1).state;
  const auto *e = pt_entry(s1, 1);
  check(e != nullptr && !e->trails && e->trail_poses == 0 && e->floats->size() == 31,
        "poses while trails are off: trail_poses 0, 31 floats on the wire");
  grc::rs::Mirror::ParticlesArgs on = pt_i(1);
  on.f = {0.5f};
  m.particles_call(0x900, PtOp::SetTrails, on, 2);
  Snapshot s2 = m.snapshot(2, 2).state;
  e = pt_entry(s2, 1);
  check(e != nullptr && e->trails && e->trail_poses == 1 && e->floats->size() == 43 &&
            (*e->floats)[31 + 10] == -4.0f,
        "trails on: the kept pose returns (trail_poses 1, 43 floats)");
}

// PM7 (render-stream-12.md "As built (PM7)"): an adopted emitter, its references and its
// subemitter linked once that one is adopted too.
void test_particles_adopt() {
  using grc::rs2::ParticlesStatus;
  Mirror m;
  bind_root(&m);
  m.set_v11(v11_options(grc::rs2::MeshDynamicMode::Auto));
  m.set_multimesh(mm_options());
  m.set_particles(pt_options());
  m.canvas_item_create(100, 1);
  m.canvas_item_create(101, 1);
  m.mesh_create(0x500, 1);
  grc::rs::Mirror::ParticlesAdopt a;
  a.emitting = true;
  a.amount = 12;
  a.fixed_fps = 0;
  a.seed = 7;
  a.mesh = 0x500;
  a.material = 0x777;  // unknown to the mirror: the entry's usual reason
  a.subemitter = 0x902;  // not adopted yet: left null
  a.floats.assign(31, 0.0f);
  a.floats[1] = 2.0f;
  auto r = m.particles_adopt(0x900, a, 1);
  check(r.known && r.accepted && r.id == 1 && r.version == 1 && r.restarts == 1,
        "adopt: id 1, version 1, the constructor's restart");
  check(!m.particles_adopt(0x900, a, 1).known, "adopting a known emitter does nothing");
  grc::rs::Mirror::ParticlesAdopt bad = a;
  bad.floats.resize(30);
  check(!m.particles_adopt(0x903, bad, 1).known, "adopt: the floats must be 31 + 12 x poses");
  m.add_particles(100, 0x900, 0, 1);
  Snapshot s1 = m.snapshot(1, 1).state;
  const auto *e = pt_entry(s1, 1);
  check(e != nullptr && e->origin == grc::rs2::Origin::Adopted && e->mode_2d && e->emitting &&
            e->amount == 12 && e->seed == 7 && e->restarts == 1 && e->subemitter == 0 &&
            e->draw_passes == std::vector<uint32_t>({1}) &&
            e->status == ParticlesStatus::Unsupported &&
            e->reason == grc::rs2::ParticlesReason::UnknownMaterial && (*e->floats)[1] == 2.0f,
        "adopted entry: origin adopted, the getters, mesh 1, unknown-material");
  grc::rs::Mirror::ParticlesAdopt sub;
  sub.mesh = 0x500;
  sub.floats.assign(31, 0.0f);
  r = m.particles_adopt(0x902, sub, 2);
  check(r.known && r.id == 2, "the subemitter adopted later: id 2");
  r = m.particles_call(0x900, PtOp::SetSubemitter, pt_i(0, 0x902), 2);
  check(r.accepted && r.changed && r.ref_id == 2, "the link, as particles_set_subemitter");
  Snapshot s2 = m.snapshot(2, 2).state;
  e = pt_entry(s2, 1);
  check(e != nullptr && e->subemitter == 2 && pt_entry(s2, 2) != nullptr &&
            pt_entry(s2, 2)->origin == grc::rs2::Origin::Adopted,
        "the subemitter published through its parent");
}

// GLES3's defaults, version moves by value / bit pattern, the counters always move.
void test_particles_defaults_and_versions() {
  using grc::rs2::ParticlesStatus;
  Mirror m;
  pt_scene(&m);
  Snapshot s1 = m.snapshot(1, 1).state;
  const auto *e = pt_entry(s1, 1);
  check(e != nullptr && e->status == ParticlesStatus::Ok && e->version == 2 && e->mode_2d &&
            !e->emitting && e->amount == 0 && e->interpolate && e->draw_order == 0 &&
            e->seed == 0 && e->fixed_fps == 30 && e->floats != nullptr && e->floats->size() == 31,
        "create (1) + set_mode 2d (2): ok, GLES3 defaults (fixed_fps 30), 31 floats");
  check(e != nullptr && (*e->floats)[0] == 1.0f && (*e->floats)[1] == 1.0f &&
            (*e->floats)[5] == 1.0f && (*e->floats)[6] == 0.01f && (*e->floats)[10] == -4.0f &&
            (*e->floats)[15] == 8.0f && (*e->floats)[16] == 1.0f && (*e->floats)[20] == 1.0f &&
            (*e->floats)[24] == 1.0f,
        "default floats: ratios 1, collision_base_size 0.01, AABB (-4,-4,-4,8,8,8), identity transform");
  check(s1.particles_commands, "a snapshot with an add_particles is flagged for lowering");
  auto r = m.particles_call(0x900, PtOp::SetAmount, pt_i(8), 2);
  check(r.known && r.accepted && r.changed && r.version == 3, "set_amount 8: version 3");
  r = m.particles_call(0x900, PtOp::SetAmount, pt_i(8), 2);
  check(r.accepted && !r.changed && r.version == 3, "an identical re-set costs nothing");
  r = m.particles_call(0x900, PtOp::SetLifetime, pt_f({2.0f}), 2);
  check(r.changed && r.version == 4, "set_lifetime: a float by bit pattern");
  std::vector<float> xf = {1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 50, 0};
  m.particles_call(0x900, PtOp::SetEmissionTransform, pt_f(xf), 2);
  r = m.particles_call(0x900, PtOp::SetEmissionTransform, pt_f(xf), 2);
  check(!r.changed && r.version == 5, "the same emission transform each frame costs nothing");
  r = m.particles_call(0x900, PtOp::Restart, pt_i(0), 2);
  check(r.changed && r.version == 6, "restart always moves the version");
  r = m.particles_call(0x900, PtOp::RequestProcessTime, pt_f({0.0f}), 2);
  check(r.changed && r.version == 7, "request_process_time always moves it");
  r = m.particles_call(0x900, PtOp::RequestProcess, pt_i(0), 2);
  check(r.accepted && !r.changed, "request_process: accepted, nothing the entry carries");
  r = m.particles_call(0x900, PtOp::SetDrawPassMesh, pt_i(0, 0x500), 2);
  check(!r.accepted && !r.changed, "a draw pass mesh outside the pass list is refused");
  m.particles_call(0x900, PtOp::SetDrawPasses, pt_i(1), 2);
  r = m.particles_call(0x900, PtOp::SetDrawPassMesh, pt_i(0, 0x500), 2);
  check(r.accepted && r.changed && r.ref_id == 1, "set_draw_pass_mesh names mesh 1");
  r = m.particles_call(0x999, PtOp::SetAmount, pt_i(3), 2);
  check(!r.known && !r.accepted, "an unknown emitter changes nothing");
  Snapshot s2 = m.snapshot(2, 2).state;
  e = pt_entry(s2, 1);
  check(e != nullptr && e->amount == 8 && e->restarts == 1 && e->process_requests == 1 &&
            e->draw_passes == std::vector<uint32_t>({1}) && (*e->floats)[1] == 2.0f &&
            (*e->floats)[25] == 100.0f,
        "the entry carries the counters, the pass and the floats");
  const auto notes = m.take_particles_states();
  check(notes.size() == 2 && notes[0].frame == 1 && notes[1].frame == 2 &&
            notes[1].entry.version == e->version,
        "one state note per published frame whose version moved");
  m.snapshot(3, 3);
  check(m.take_particles_states().empty(), "no note without a change");
}

// Reasons, the item-level entries, unknown-particles, publication over subemitters, tombstones.
void test_particles_reasons_and_publication() {
  using grc::rs2::ParticlesStatus;
  using grc::rs2::ParticlesReason;
  using grc::rs2::UnsupportedReason;
  Mirror m;
  pt_scene(&m);
  m.particles_create(0x901, 1);  // emitter 2: 3d (the default), not drawn yet
  m.particles_create(0x902, 1);  // emitter 3: 2d, a subemitter of emitter 1 only
  m.particles_call(0x902, PtOp::SetMode, pt_i(0), 1);
  m.particles_call(0x900, PtOp::SetSubemitter, pt_i(0, 0x902), 1);
  m.canvas_item_create(101, 1);
  m.add_particles(101, 0x901, 0, 1);
  m.add_particles(101, 0x777, 0, 1);  // unknown
  Snapshot s = m.snapshot(1, 1).state;
  check(s.particles.size() == 3 && pt_entry(s, 3) != nullptr && pt_entry(s, 1)->subemitter == 3,
        "a published entry's subemitter is in the table");
  const auto *e2 = pt_entry(s, 2);
  check(e2 != nullptr && e2->status == ParticlesStatus::Unsupported &&
            e2->reason == ParticlesReason::Particles3d,
        "a 3d emitter in a canvas: particles-3d");
  bool unknown = false;
  bool unsupported = false;
  for (const auto &u : s.unsupported) {
    unknown = unknown || (u.op == "canvas_item_add_particles" && u.item == 2 &&
                          u.reason == UnsupportedReason::UnknownParticles);
    unsupported = unsupported || (u.op == "canvas_item_add_particles" && u.item == 2 &&
                                  u.reason == UnsupportedReason::UnsupportedParticles);
  }
  check(unknown && unsupported, "unknown-particles and the derived unsupported-particles entries");
  m.particles_call(0x900, PtOp::SetProcessMaterial, pt_i(0, 0xabc), 2);
  Snapshot s2 = m.snapshot(2, 2).state;
  check(pt_entry(s2, 1)->status == ParticlesStatus::Unsupported &&
            pt_entry(s2, 1)->reason == ParticlesReason::UnknownMaterial &&
            pt_entry(s2, 1)->process_material == 0,
        "an unknown process material: unknown-material, written as null");
  // Free emitter 2 while drawn: a tombstone; then stop drawing it: it leaves.
  const auto fr = m.particles_free(0x901, 3);
  check(fr.known && fr.changed, "free moves the version");
  Snapshot s3 = m.snapshot(3, 3).state;
  const auto *t = pt_entry(s3, 2);
  check(t != nullptr && t->status == ParticlesStatus::Freed && t->floats == nullptr &&
            !t->mode_2d,
        "a freed emitter still drawn is a tombstone keeping its JSON fields");
  m.clear(101, 4);
  Snapshot s4 = m.snapshot(4, 4).state;
  check(pt_entry(s4, 2) == nullptr, "a tombstone nothing names leaves");
  s3.version = s4.version = grc::rs2::ProtocolVersion::V12;
  const grc::rs2::Transaction p = grc::rs2::make_patch(s3, s4);
  check(p.removed_particles == std::vector<uint32_t>({2}), "removed_particles [2]");
}

// The emit log: emits of a frame form one chunk; (B, T] over a gap; drop-restart skews the wire.
void test_particles_emits_and_drop_restart() {
  Mirror m;
  pt_scene(&m, pt_options(3));
  Snapshot s1 = m.snapshot(1, 1).state;
  grc::rs::Mirror::ParticlesArgs emit;
  emit.f.assign(23, 0.5f);
  emit.flags = 5;
  m.particles_call(0x900, PtOp::Emit, emit, 2);
  m.particles_call(0x900, PtOp::Emit, emit, 2);
  Snapshot s2 = m.snapshot(2, 2).state;
  m.particles_call(0x900, PtOp::Restart, pt_i(0), 3);  // dropped from the wire (frame 3)
  const auto r = m.particles_call(0x900, PtOp::Emit, emit, 3);
  check(r.restarts == 1, "the hook log's emit carries the host's true restarts");
  Snapshot s3 = m.snapshot(3, 3).state;
  s1.version = s2.version = s3.version = grc::rs2::ProtocolVersion::V12;
  check(grc::rs2::make_full(s2).particle_emits.size() == 2 &&
            grc::rs2::make_full(s3).particle_emits.size() == 1,
        "a full lists its own frame's emits");
  const grc::rs2::Transaction p = grc::rs2::make_patch(s1, s3);
  check(p.particle_emits.size() == 3 && p.particle_emits[0].flags == 5 &&
            p.particle_emits[2].restarts == 0,
        "a patch over a gap lists (B, T]; drop-restart: the wire's restarts did not move");
  const auto *e = pt_entry(s3, 1);
  check(e != nullptr && e->restarts == 0 && e->emits == 3, "the wire entry misses the restart");
  const auto notes = m.take_particles_states();
  check(!notes.empty() && notes.back().entry.restarts == 1 &&
            notes.back().entry.version == e->version + 1,
        "the hook log's state line has the host's true restarts and version");
  // The tail is bounded.
  for (int f = 4; f < 4 + 5; ++f) {
    for (int i = 0; i < 1000; ++i) {
      m.particles_call(0x900, PtOp::Emit, emit, static_cast<uint64_t>(f));
    }
    m.snapshot(static_cast<uint64_t>(f), static_cast<uint64_t>(f));
  }
  Snapshot last = m.snapshot(9, 9).state;
  size_t held = 0;
  for (const auto &chunk : *last.emit_tail) held += chunk->emits.size();
  check(held == grc::rs2::kParticleEmitTail, "the emit tail holds exactly the last 4,096 emits");
}

// The particle_process_material builtin, its /11 lowering, and a plain Array parameter's form.
void test_particles_builtin_and_lowering() {
  using grc::rs2::ShaderStatus;
  Mirror m;
  pt_scene(&m);
  grc::rs::ShaderCodeInput input = shader_input("shader_type particles;\n", "unsupported",
                                                "shader-mode");
  input.copy.mode = "particles";
  m.shader_create_from_code(0x600, input, 1);
  m.material_create(0x610, 1);
  m.material_set_shader(0x610, 0x600, 1);
  grc::rs::DecodedParam array;
  array.type = "array";
  array.status = "unsupported";
  array.reason = "param-type";
  array.array_form = true;
  array.array_type = "int32";
  array.array_n = 2;
  array.array_f = {1.0, 0.0};
  m.material_set_param(0x610, "particle_flags", array, 1);
  m.particles_call(0x900, PtOp::SetProcessMaterial, pt_i(0, 0x610), 1);
  const auto candidates = m.ppm_candidates();
  check(candidates.size() == 1 && candidates[0].shader_rid == 0x600 &&
            candidates[0].pairs.size() == 1 && candidates[0].pairs[0].first == 0x610 &&
            candidates[0].pairs[0].second == 100,
        "the candidate: shader, (process material, drawing item)");
  Snapshot before = m.snapshot(1, 1).state;
  check(before.shaders[0].status == ShaderStatus::Unsupported && !before.shaders[0].has_ppm,
        "unkeyed: shader-mode");
  check(before.materials[0].status == grc::rs2::MaterialStatus::Ok &&
            before.materials[0].params.size() == 1 && before.materials[0].below_v12 != nullptr &&
            before.materials[0].below_v12->status == grc::rs2::MaterialStatus::Unsupported,
        "/12 carries the Array as packed int32; below /12 it stays param-type");
  grc::rs2::BuiltinParticleProcessMaterial key;
  key.emission_shape = 3;
  key.textures = 1u << 8;
  m.set_shader_ppm(0x600, key);
  check(m.ppm_candidates().empty(), "a keyed shader is no candidate");
  Snapshot s = m.snapshot(2, 2).state;
  const auto &sh = s.shaders[0];
  check(sh.status == ShaderStatus::Ok && sh.has_ppm && sh.ppm == key && sh.below_v12 != nullptr &&
            sh.below_v12->status == ShaderStatus::Unsupported && !sh.below_v12->has_ppm,
        "keyed: ok at /12, shader-mode below /12");
  check(m.stats().ppm_resolved == 1, "counted");
  Snapshot v11 = s;
  v11.version = grc::rs2::ProtocolVersion::V11;
  const grc::rs2::Transaction t = grc::rs2::make_full(v11);
  check(t.particles.empty() && !t.shaders[0].has_ppm &&
            t.shaders[0].status == ShaderStatus::Unsupported &&
            t.materials[0].status == grc::rs2::MaterialStatus::Unsupported,
        "a /11 viewer of a /12 host: shader-mode, param-type, no particles");
  // Byte identity of the /11 view with a mirror that never had particles.
  Mirror without;
  bind_root(&without);
  without.set_v11(v11_options(grc::rs2::MeshDynamicMode::Auto));
  without.set_multimesh(mm_options());
  without.canvas_item_create(100, 1);
  without.mesh_create(0x500, 1);
  without.add_unsupported(100, "canvas_item_add_particles", 1);
  Mirror with;
  pt_scene(&with);
  Snapshot a = with.snapshot(1, 1).state;
  Snapshot b = without.snapshot(1, 1).state;
  check(item(a, 1)->content_version != item(b, 1)->content_version &&
            item(a, 1)->content_version_below_v12 == item(b, 1)->content_version &&
            item(a, 1)->content_version_below_v11 == item(b, 1)->content_version,
        "the /12 digest differs; the /11 and /10 digests are the pre-PM5 one");
  a.version = b.version = grc::rs2::ProtocolVersion::V11;
  check(grc::rs2::encode_transaction(grc::rs2::make_full(a)) ==
            grc::rs2::encode_transaction(grc::rs2::make_full(b)),
        "a /11 full transaction of a /12 host is the pre-PM5 one");
  a.version = b.version = grc::rs2::ProtocolVersion::V10;
  check(grc::rs2::encode_transaction(grc::rs2::make_full(a)) ==
            grc::rs2::encode_transaction(grc::rs2::make_full(b)),
        "and so is a /10 one");
  // Disabled (below /12): add_particles stays /11's unsupported-op command.
  Mirror off;
  bind_root(&off);
  off.canvas_item_create(100, 1);
  off.particles_create(0x900, 1);
  off.add_particles(100, 0x900, 0, 1);
  Snapshot o = off.snapshot(1, 1).state;
  check(o.particles.empty() && !o.particles_commands && item(o, 1)->commands.size() == 1 &&
            item(o, 1)->commands[0].kind == CommandKind::Unsupported,
        "disabled: no table, the command is unsupported-op");
}

int main() {
  // HC4a: RS_MIRROR_TEST_SHADOW=1 (the rs_mirror_shadow ctest) runs every case with the shadow
  // oracle on: every snapshot of every Mirror is also built by the full walk and compared.
  const char *shadow = std::getenv("RS_MIRROR_TEST_SHADOW");
  const bool shadow_on = shadow != nullptr && std::string(shadow) == "1";
  Mirror::set_default_hc_shadow(shadow_on);
  test_hc4a_persistent_tables();
  test_hc4a_shadow_sabotages();
  test_same_value_set_material_keeps_epoch();
  test_particles_defaults_and_versions();
  test_particles_trail_poses_need_trails();
  test_particles_adopt();
  test_particles_reasons_and_publication();
  test_particles_emits_and_drop_restart();
  test_particles_builtin_and_lowering();
  test_multimesh_shadow_and_versions();
  test_multimesh_reasons();
  test_multimesh_publication_and_free();
  test_multimesh_stale_buffer_and_patch();
  test_multimesh_lowered_below_v11();
  test_v11_mesh_classification();
  test_v11_mesh_modes();
  test_v11_stable_content_version();
  test_hc2_shared_command_lists();
  test_hc3_lazy_mesh_surfaces();
  test_backbuffer_state();
  test_fresh_session();
  test_ids_and_recycled_rid();
  test_append_on_same_parent();
  test_free_canvas_and_item();
  test_content_versions();
  test_setters();
  test_unsupported_and_material();
  test_viewport_hooks();
  test_unknown_rid();
  test_root_query_failure();
  test_omit_update();
  test_capacity();
  test_process_wide_gate();
  test_detach_reattach_keeps_id();
  test_raw_parent_free_leaves_detached_child();
  test_rs_defaults();
  test_set_z_relative_and_behind();
  test_tie_two_siblings();
  test_tie_non_drawing_never_ties();
  test_tie_children_only_counts_as_drawing();
  test_tie_three_way();
  test_tie_under_item_children();
  test_tie_resolved_by_set_draw_index();
  test_tie_ordering_with_unsupported_op();
  test_tie_new_top_level_item_until_raise();
  test_degenerate_host_size_first();
  test_root_size_enforce_failed();
  test_omit_op_free();
  test_omit_op_visible_only();
  test_omit_op_identity_creates();
  test_epoch();
  test_process_wide_g1b2();
  test_texture_ids_versions_and_payloads();
  test_texture_replace_free_and_tombstones();
  test_texture_unsupported_copies_and_filters();
  test_texture_omit_op_and_spurious();
  test_canvas_texture();
  test_canvas_texture_headless_refusal();
  test_clear_resets_clip();
  test_clear_then_reassert_clip();
  test_omit_clip_then_clear();
  test_clip_ignore_tap();
  test_geometry_taps();
  test_geometry_texture_ambiguity();
  test_perturb_vertex();
  test_msdf_command_with_outline();
  test_msdf_unknown_texture();
  test_msdf_omit_op();
  test_perturb_glyph();
  test_attach_skeleton_tap();
  test_mesh_table_lifecycle();
  test_mesh_add_mesh_and_tombstones();
  test_mesh_unsupported_and_unknown();
  test_mesh_omit_op_and_perturb_vertex();
  test_skip_strict_default_unchanged();
  test_skip_unknown_target();
  test_skip_unknown_parent();
  test_skip_reparent_into_and_out_of_withheld();
  test_skip_free_unknown();
  test_skip_patch_full_equivalence();
  test_material_tables_lifecycle();
  test_material_params();
  test_material_params_shared();
  test_material_items_and_derived_entries();
  test_canvas_modulate_and_light();
  test_canvas_layers();
  test_canvas_session_entries();
  test_shader_policy_and_perturb();
  test_material_omit_op();
  if (shadow_on) {
    check(Mirror::hc_shadow_mismatches_total() == g_expected_shadow_mismatches,
          "HC4a shadow oracle: every snapshot of every case equals the full walk");
  }
  if (g_failures != 0) {
    std::fprintf(stderr, "rs_mirror_test: %d of %d checks failed\n", g_failures, g_checks);
    return 1;
  }
  std::printf("rs_mirror_test: all %d checks passed\n", g_checks);
  return 0;
}
