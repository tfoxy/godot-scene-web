// Unit test for the render-stream/0 retained canvas mirror (src/rs0_mirror.h).
//
// Drives the mirror through its public API exactly as the hooks do, with plain
// uint64 RIDs and no engine, and checks the snapshots against
// protocol/gate0-design.md "Q1" and "Q3" and render-stream-0.md "Transaction".

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs0_mirror.h"

namespace {

using grc::rs0::Color4;
using grc::rs0::CommandKind;
using grc::rs0::FailureReason;
using grc::rs0::Mirror;
using grc::rs0::ParentKind;
using grc::rs0::Rect4;
using grc::rs0::Snapshot;
using grc::rs0::UnsupportedReason;
using grc::rs0::Xform;

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

const grc::rs0::ItemState *item(const Snapshot &s, uint32_t id) {
  for (const auto &it : s.items) {
    if (it.id == id) return &it;
  }
  return nullptr;
}

const grc::rs0::CanvasState *canvas(const Snapshot &s, uint32_t id) {
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

void test_fresh_session() {
  Mirror m;
  bind_root(&m);
  const Snapshot s = m.snapshot(7, 9);
  check(s.seq == 7 && s.frame == 9, "seq and frame are copied");
  check(s.failures.empty(), "a bound root has no failure");
  check(s.status() == grc::rs0::TransactionStatus::Ok, "status ok");
  check(s.canvases.size() == 1, "only the root canvas");
  const auto *root = canvas(s, 1);
  check(root != nullptr && root->origin == grc::rs0::Origin::RootQuery &&
            root->role == grc::rs0::CanvasRole::Root && root->attached && root->items.empty(),
        "canvas 1 is the root: root-query, role root, attached, no items");
  check(s.items.empty() && s.unsupported.empty(), "no items, no unsupported");
}

void test_ids_and_recycled_rid() {
  Mirror m;
  bind_root(&m);
  m.canvas_item_create(100, 1);
  m.canvas_item_create(101, 1);
  m.canvas_create(200, 1);
  Snapshot s = m.snapshot(1, 1);
  check(item(s, 1) != nullptr && item(s, 2) != nullptr, "items get ids 1, 2");
  check(canvas(s, 2) != nullptr && canvas(s, 2)->origin == grc::rs0::Origin::Created &&
            canvas(s, 2)->role == grc::rs0::CanvasRole::None && !canvas(s, 2)->attached,
        "a created canvas gets id 2 (after the root), role none, not attached");
  check(item(s, 1)->visibility_layer == 0xFFFFFFFFu && item(s, 1)->visible &&
            item(s, 1)->modulate == grc::rs0::kWhite && item(s, 1)->content_version == 0 &&
            item(s, 1)->parent.kind == ParentKind::None,
        "a new item has the RenderingServer defaults");

  // Free item 1, then let the engine hand the same RID value out again: it is
  // a new object and must get a new id, never 1 again.
  m.free_rid(100, 2);
  m.canvas_item_create(100, 2);
  s = m.snapshot(2, 2);
  check(item(s, 1) == nullptr, "freed item 1 is gone");
  check(item(s, 3) != nullptr, "the recycled RID gets id 3");
  check(s.items.size() == 2 && s.items[0].id == 2 && s.items[1].id == 3, "items sorted by id");

  m.free_rid(200, 3);
  m.canvas_create(200, 3);
  s = m.snapshot(3, 3);
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
  Snapshot s = m.snapshot(1, 1);
  check(canvas(s, 1)->items == ids({1, 2}), "root canvas lists 1, 2 in append order");
  check(item(s, 1)->children == ids({3}), "item 1 lists child 3");
  check(item(s, 3)->parent.kind == ParentKind::Item && item(s, 3)->parent.id == 1,
        "item 3's parent is item 1");
  check(item(s, 1)->parent.kind == ParentKind::Canvas && item(s, 1)->parent.id == 1,
        "item 1's parent is canvas 1");

  // renderer_canvas_cull.cpp:569-598: setting the same parent again removes
  // and re-appends.
  m.set_parent(100, kRootCanvas, 2);
  s = m.snapshot(2, 2);
  check(canvas(s, 1)->items == ids({2, 1}), "re-parenting to the same canvas appends at the end");

  // Move item 3 from item 1 to the root canvas, then detach item 2.
  m.set_parent(102, kRootCanvas, 3);
  m.set_parent(101, 0, 3);
  s = m.snapshot(3, 3);
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
  Snapshot s = m.snapshot(1, 2);
  check(canvas(s, 2) == nullptr, "freed canvas 2 is gone");
  check(item(s, 1)->parent.kind == ParentKind::None && item(s, 2)->parent.kind == ParentKind::None,
        "the freed canvas's items are detached");

  // Free an item: it leaves its parent's list and its children are orphaned
  // (:2585-2600).
  m.free_rid(102, 3);
  s = m.snapshot(2, 3);
  check(item(s, 3) == nullptr, "freed item 3 is gone");
  check(canvas(s, 1)->items.empty(), "freed item 3 left the root canvas's list");
  check(item(s, 4)->parent.kind == ParentKind::None, "freed item 3's child is detached");

  // A freed RID is unknown afterwards.
  m.set_visible(102, false, 4);
  s = m.snapshot(3, 4);
  check(has_failure(s, FailureReason::PreExistingObject), "a call on a freed item's RID fails");

  // free() of an unknown RID (a texture, a mesh) is counted and ignored.
  Mirror n;
  bind_root(&n);
  n.free_rid(999, 1);
  check(n.stats().free_unknown == 1, "free of an unknown RID is counted");
  check(n.snapshot(1, 1).failures.empty(), "free of an unknown RID is not a failure");

  // Freeing the root canvas keeps canvas 1 in every snapshot.
  n.canvas_item_create(100, 1);
  n.set_parent(100, kRootCanvas, 1);
  n.free_rid(kRootCanvas, 2);
  s = n.snapshot(2, 2);
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
  Snapshot s = m.snapshot(1, 1);
  const auto *it = item(s, 1);
  check(it->content_version == 2, "clear + add_rect bump content_version to 2");
  check(it->commands.size() == 1 && it->commands[0].kind == CommandKind::AddRect &&
            it->commands[0].rect == kRect && it->commands[0].color == kRed &&
            !it->commands[0].antialiased,
        "add_rect is recorded with its rect, colour and antialiased flag");

  // A transform-only change does not touch content_version.
  m.set_transform(100, {1, 0, 0, 1, 288, 96}, 2);
  s = m.snapshot(2, 2);
  check(item(s, 1)->content_version == 2, "set_transform leaves content_version alone");
  check(item(s, 1)->xform[4] == 288.0f && item(s, 1)->xform[5] == 96.0f, "transform stored");

  m.clear(100, 3);
  m.add_rect(100, kRect, kGreen, true, 3);
  s = m.snapshot(3, 3);
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
  const Snapshot s = m.snapshot(1, 1);
  const auto *it = item(s, 1);
  check(it->modulate == Color4{0.5f, 0.5f, 0.5f, 1}, "modulate stored");
  check(it->self_modulate == kRed, "self_modulate stored");
  check(!it->visible && it->clip, "visible and clip stored");
  check(it->custom_rect && it->custom_rect_rect == Rect4{1, 2, 3, 4}, "custom rect stored");
  check(it->visibility_layer == 1 && it->z_index == -3 && it->draw_index == 7,
        "visibility_layer, z_index and draw_index stored");
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
  Snapshot s = m.snapshot(1, 1);

  const auto *two = item(s, 2);
  check(two->commands.size() == 4 && two->commands[1].kind == CommandKind::Unsupported &&
            two->commands[1].name == "canvas_item_add_line" &&
            two->commands[2].name == "canvas_item_add_circle",
        "unsupported commands keep their place in command order");
  check(two->content_version == 4, "each add_* bumps content_version (material does not)");
  check(two->unsupported_state, "a non-null material sets unsupported_state");

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
  s = m.snapshot(2, 2);
  check(!item(s, 2)->unsupported_state, "a null material clears unsupported_state");
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
  Snapshot s = m.snapshot(1, 1);
  check(s.unsupported.empty() && s.failures.empty(), "root attach and transform are supported");
  check(canvas(s, 1)->xform == Xform{2, 0, 0, 2, 5, 6}, "root canvas transform stored");

  // A second canvas on the root viewport: attached, and extra-canvas (sticky).
  m.viewport_attach_canvas(kRootViewport, 200, 2);
  m.viewport_set_canvas_transform(kRootViewport, 200, {1, 0, 0, 1, 3, 4}, 2);
  // A non-root viewport: non-root-viewport for both ops, mirror unchanged.
  m.viewport_attach_canvas(0x9999, 200, 2);
  m.viewport_set_canvas_transform(0x9999, kRootCanvas, {9, 9, 9, 9, 9, 9}, 2);
  m.viewport_attach_canvas(0x9999, 200, 2);  // de-duplicated
  s = m.snapshot(2, 2);
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
  s = m.snapshot(3, 3);
  check(s.unsupported.size() == 4 && !s.unsupported[2].has_item && s.unsupported[3].has_item,
        "session-level entries first, sticky, then item-level");

  // An unknown canvas on the root viewport is pre-existing-object.
  Mirror n;
  bind_root(&n);
  n.viewport_set_canvas_transform(kRootViewport, 0x5555, kRootXform, 4);
  s = n.snapshot(1, 4);
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
  Snapshot s = m.snapshot(1, 3);
  check(s.status() == grc::rs0::TransactionStatus::CaptureFailure, "status capture-failure");
  check(s.failures.size() == 1 && s.failures[0].reason == FailureReason::PreExistingObject &&
            s.failures[0].detail == "rid=2748 op=canvas_item_set_parent frame=1",
        "pre-existing-object names the first event only");
  check(item(s, 1)->parent.kind == ParentKind::None, "a call with an unknown parent changes nothing");

  // Sticky: still there after more good calls.
  m.set_visible(100, false, 4);
  s = m.snapshot(2, 4);
  check(s.failures.size() == 1 && !item(s, 1)->visible, "sticky, and good calls still apply");

  // An unknown parent alone is also pre-existing-object.
  Mirror n;
  bind_root(&n);
  n.canvas_item_create(100, 1);
  n.set_parent(100, 0x777, 5);
  s = n.snapshot(1, 5);
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
  const Snapshot s = m.snapshot(1, 1);
  check(s.failures.size() == 1 && s.failures[0].reason == FailureReason::RootQueryFailed &&
            s.failures[0].detail == "Viewport.get_world_2d",
        "root-query-failed is sticky and keeps the first detail");
  check(canvas(s, 1) != nullptr, "canvas 1 still exists after a failed root query");
  // With no root viewport bound, every viewport is non-root.
  m.viewport_attach_canvas(0, 0, 1);
  check(m.snapshot(2, 1).unsupported.size() == 1, "zero viewport RID never matches the root");
}

void test_omit_update() {
  Mirror m;
  bind_root(&m);
  m.set_drop_frame(21);
  m.canvas_item_create(100, 1);
  m.set_parent(100, kRootCanvas, 1);
  m.add_rect(100, kRect, kRed, false, 1);
  const Snapshot before = m.snapshot(1, 20);

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
  const Snapshot after = m.snapshot(2, 22);

  const auto *a = item(after, 1);
  const auto *b = item(before, 1);
  check(a->content_version == b->content_version && a->commands.size() == 1 &&
            a->commands[0].color == kRed,
        "frame-21 clear/add_rect dropped");
  check(a->xform == b->xform && a->modulate == b->modulate &&
            a->self_modulate == b->self_modulate && a->visible && !a->clip && !a->custom_rect &&
            a->visibility_layer == b->visibility_layer && a->z_index == 0 &&
            a->draw_index == 0 && !a->unsupported_state,
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
  check(item(m.snapshot(3, 23), 1)->z_index == 5, "drop frame 0 disables the sabotage");
}

void test_capacity() {
  Mirror m;
  bind_root(&m);
  for (uint64_t i = 0; i < grc::rs0::kMaxLiveItems; ++i) {
    m.canvas_item_create(1000 + i, 1);
  }
  Snapshot s = m.snapshot(1, 1);
  check(s.items.size() == grc::rs0::kMaxLiveItems && s.failures.empty(),
        "exactly the cap of live items is fine");
  const uint64_t over = 1000 + grc::rs0::kMaxLiveItems;
  m.canvas_item_create(over, 2);
  m.set_parent(over, kRootCanvas, 2);  // untracked: ignored, not pre-existing
  m.add_rect(over, kRect, kRed, false, 2);
  s = m.snapshot(2, 2);
  check(s.items.size() == grc::rs0::kMaxLiveItems, "the item over the cap is not tracked");
  check(s.failures.size() == 1 && s.failures[0].reason == FailureReason::MirrorCapacity,
        "live items over the cap -> mirror-capacity only (no pre-existing-object)");
  check(m.stats().ignored_untracked == 2, "calls on the untracked item are counted");
  m.free_rid(over, 3);
  check(m.stats().free_unknown == 0, "freeing the untracked item is not an unknown free");

  // Freeing one makes room again, but the failure is sticky.
  m.free_rid(1000, 4);
  m.canvas_item_create(9, 4);
  s = m.snapshot(3, 4);
  check(s.items.size() == grc::rs0::kMaxLiveItems && s.items.back().id ==
                                                         grc::rs0::kMaxLiveItems + 1,
        "after a free there is room; the new item gets the next id");
  check(s.failures.size() == 1, "mirror-capacity is sticky");

  Mirror n;
  bind_root(&n);
  n.canvas_item_create(100, 1);
  for (size_t i = 0; i < grc::rs0::kMaxCommandsPerItem; ++i) {
    n.add_rect(100, kRect, kRed, false, 1);
  }
  s = n.snapshot(1, 1);
  check(s.failures.empty() && item(s, 1)->commands.size() == grc::rs0::kMaxCommandsPerItem,
        "exactly the command cap is fine");
  n.add_rect(100, kRect, kGreen, false, 2);
  n.add_unsupported(100, "canvas_item_add_line", 2);
  s = n.snapshot(2, 2);
  check(item(s, 1)->commands.size() == grc::rs0::kMaxCommandsPerItem,
        "commands over the cap are dropped");
  check(item(s, 1)->content_version == grc::rs0::kMaxCommandsPerItem,
        "dropped commands do not bump content_version");
  check(s.failures.size() == 1 && s.failures[0].reason == FailureReason::MirrorCapacity &&
            s.failures[0].detail == "commands > 1024 item=1 frame=2",
        "commands over the cap -> mirror-capacity");
}

void test_process_wide_gate() {
  using namespace grc::rs0;
  check(!mirror_enabled(), "the process-wide mirror starts disabled");
  mirror_enable(true);
  check(mirror_enabled(), "enabled");
  mirror_set_root(kRootViewport, kRootCanvas, kRootXform);
  mirror_instance().canvas_item_create(100, 1);
  mirror_set_drop_frame(5);
  mirror_instance().set_z_index(100, 3, 5);
  Snapshot s = mirror_snapshot(1, 1);
  check(s.items.size() == 1 && s.items[0].z_index == 0, "mirror_set_drop_frame applies");
  mirror_enable(true);  // already enabled: no reset
  check(mirror_snapshot(2, 2).items.size() == 1, "re-enabling while enabled keeps the state");
  mirror_enable(false);
  check(mirror_snapshot(3, 3).items.size() == 1, "disabling keeps the state readable");
  mirror_enable(true);
  s = mirror_snapshot(4, 4);
  check(s.items.empty() && s.canvases.size() == 1, "enabling from disabled starts a new session");
  mirror_fail_root_query("Engine.get_main_loop");
  check(mirror_snapshot(5, 5).failures.size() == 1, "mirror_fail_root_query");
  check(mirror_stats().live_canvases == 1, "mirror_stats");
  mirror_enable(false);
}

}  // namespace

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
  if (g_failures != 0) {
    std::fprintf(stderr, "rs0_mirror_test: %d of %d checks failed\n", g_failures, g_checks);
    return 1;
  }
  std::printf("rs0_mirror_test: all %d checks passed\n", g_checks);
  return 0;
}
