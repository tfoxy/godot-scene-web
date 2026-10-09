// Unit test for the retained canvas mirror (src/rs_mirror.h).
//
// Drives the mirror through its public API exactly as the hooks do, with plain
// uint64 RIDs and no engine, and checks the snapshots against
// protocol/gate0-design.md "Q1" and "Q3", render-stream-0.md "Transaction",
// and (gate 1, G1b2) render-stream-1.md "Invariant 9" / "Unsupported reasons"
// and gate1-design.md "Q1", "Q4" and "G1b2" (omit-op, mutation epoch), and
// (gate 2, G2b2) gate2-design.md Q3 "Texture mirror" with render-stream-2.md
// "Texture" and "Item-level unsupported entries".

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs_mirror.h"
#include "rs_sha256.h"
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

bool has_material_entry(const Snapshot &s, uint32_t id) {
  for (const auto &u : s.unsupported) {
    if (u.has_item && u.item == id && u.reason == UnsupportedReason::UnsupportedState &&
        u.op == "canvas_item_set_material")
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
  check(has_material_entry(s, 2), "a non-null material gives an unsupported-state entry");

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
              u[3].reason == UnsupportedReason::UnsupportedState,
          "item 2: set_material, unsupported-state, sorted among the ops");
  }
  check(s.failures.empty(), "unsupported is not a capture failure");

  m.set_material(101, 0, 2);
  m.clear(101, 2);
  s = m.snapshot(2, 2).state;
  check(!has_material_entry(s, 2), "a null material clears the unsupported-state entry");
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

  // A second canvas on the root viewport: attached, and extra-canvas (sticky).
  m.viewport_attach_canvas(kRootViewport, 200, 2);
  m.viewport_set_canvas_transform(kRootViewport, 200, {1, 0, 0, 1, 3, 4}, 2);
  // A non-root viewport: non-root-viewport for both ops, mirror unchanged.
  m.viewport_attach_canvas(0x9999, 200, 2);
  m.viewport_set_canvas_transform(0x9999, kRootCanvas, {9, 9, 9, 9, 9, 9}, 2);
  m.viewport_attach_canvas(0x9999, 200, 2);  // de-duplicated
  s = m.snapshot(2, 2).state;
  check(canvas(s, 2)->attached && canvas(s, 2)->xform == Xform{1, 0, 0, 1, 3, 4},
        "the extra canvas is attached and its transform stored");
  check(canvas(s, 1)->xform == Xform{2, 0, 0, 2, 5, 6},
        "a non-root viewport's transform does not touch the root canvas");
  check(s.unsupported.size() == 3, "3 session-level entries");
  if (s.unsupported.size() == 3) {
    check(!s.unsupported[0].has_item && s.unsupported[0].op == "viewport_attach_canvas" &&
              s.unsupported[0].reason == UnsupportedReason::ExtraCanvas,
          "first observed: extra-canvas");
    check(s.unsupported[1].op == "viewport_attach_canvas" &&
              s.unsupported[1].reason == UnsupportedReason::NonRootViewport,
          "then attach on a non-root viewport");
    check(s.unsupported[2].op == "viewport_set_canvas_transform" &&
              s.unsupported[2].reason == UnsupportedReason::NonRootViewport,
          "then transform on a non-root viewport");
  }
  check(s.failures.empty(), "unsupported viewport use is not a failure");

  // Session-level entries come before item-level ones and stay after the
  // extra canvas is freed.
  m.canvas_item_create(100, 3);
  m.add_unsupported(100, "canvas_item_add_mesh", 3);
  m.free_rid(200, 3);
  s = m.snapshot(3, 3).state;
  check(s.unsupported.size() == 4 && !s.unsupported[2].has_item && s.unsupported[3].has_item,
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
      {2, "canvas_item_set_material", UnsupportedReason::UnsupportedState},
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

int main() {
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
  if (g_failures != 0) {
    std::fprintf(stderr, "rs_mirror_test: %d of %d checks failed\n", g_failures, g_checks);
    return 1;
  }
  std::printf("rs_mirror_test: all %d checks passed\n", g_checks);
  return 0;
}
