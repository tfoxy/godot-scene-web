// Unit test for the mirror's viewport surfaces (VS2; src/rs_mirror.h "viewport surfaces",
// protocol/render-stream-16.md "The viewport table", "Texture kinds", "Session-level unsupported
// reasons").
//
// Drives a Mirror through its public API as the hooks and the adoption walk do, with plain uint64
// RIDs and no engine:
//   - not live: the new taps change nothing, the generalized handlers keep `non-root-viewport`;
//   - live: create, size, activation order, parent and nesting, update/clear modes and their
//     sequences, the generalized canvas handlers (rows, stacking, transforms, defaults), the
//     unknown-viewport rule, the 3D rule (a camera over an empty world is not 3D), hdr/msaa;
//   - proxies: bound by adjacency, by render-target RID, by texture, unresolved, the node route,
//     re-pointing, a freed target kept as a tombstone, texture_replace redirecting proxies;
//   - free: a viewport's texture retired with it, children orphaned, canvases leaving rows;
//   - the derived item-level unsupported-texture through an `ok` proxy;
//   - adoption;
//   - the snapshots encoded at /16 (make_full / make_patch through the /13 predictor), resolved
//     back, and (RS_MIRROR_VP_OUT=<path>) written as a .rs16 recording for the TS / Rust validators.
// RS_MIRROR_TEST_SHADOW=1 runs every case with the HC4a/HC4b shadow oracle on.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

#include "rs13_predict.h"
#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs_mirror.h"

namespace {

using grc::rs::Mirror;
using grc::rs2::Color4;
using grc::rs2::FailureReason;
using grc::rs2::Filter;
using grc::rs2::Origin;
using grc::rs2::Rect4;
using grc::rs2::Repeat;
using grc::rs2::Snapshot;
using grc::rs2::TextureKind;
using grc::rs2::TextureReason;
using grc::rs2::TextureStatus;
using grc::rs2::UnsupportedReason;
using grc::rs2::ViewportClear;
using grc::rs2::ViewportEntry;
using grc::rs2::ViewportUpdate;
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

constexpr std::uint64_t kRootViewport = 0x1000;
constexpr std::uint64_t kRootCanvas = 0x2000;
constexpr Xform kRootXform = {1, 0, 0, 1, 0, 0};
constexpr Xform kIdentity = {1, 0, 0, 1, 0, 0};
constexpr Color4 kWhite = {1, 1, 1, 1};
constexpr Rect4 kRect = {0, 0, 32, 32};

// Viewport, canvas, texture, item, camera, scenario and instance RIDs.
constexpr std::uint64_t kVpA = 0x3001;
constexpr std::uint64_t kVpB = 0x3002;
constexpr std::uint64_t kVpC = 0x3003;
constexpr std::uint64_t kCanvas2 = 0x4002;
constexpr std::uint64_t kCanvas3 = 0x4003;
constexpr std::uint64_t kCamera = 0x5001;
constexpr std::uint64_t kScenario = 0x5002;
constexpr std::uint64_t kInstance = 0x5003;

void bind_root(Mirror *m, bool live) {
  m->set_viewports(live);
  m->reset();
  m->set_root(kRootViewport, kRootCanvas, kRootXform);
}

const ViewportEntry *vp(const Snapshot &s, std::uint32_t id) {
  for (const ViewportEntry &v : s.viewports) {
    if (v.id == id) return &v;
  }
  return nullptr;
}

const grc::rs2::TextureEntry *texture(const Snapshot &s, std::uint32_t id) {
  for (const auto &t : s.textures) {
    if (t.id == id) return &t;
  }
  return nullptr;
}

bool has_session_entry(const Snapshot &s, const std::string &op, UnsupportedReason reason) {
  for (const auto &u : s.unsupported) {
    if (!u.has_item && u.op == op && u.reason == reason) return true;
  }
  return false;
}

bool has_item_entry(const Snapshot &s, std::uint32_t item, const std::string &op,
                    UnsupportedReason reason) {
  for (const auto &u : s.unsupported) {
    if (u.has_item && u.item == item && u.op == op && u.reason == reason) return true;
  }
  return false;
}

bool has_failure(const Snapshot &s, FailureReason reason) {
  for (const auto &f : s.failures) {
    if (f.reason == reason) return true;
  }
  return false;
}

// An item on the root canvas drawing `tex` with add_texture_rect.
void drawing_item(Mirror *m, std::uint64_t item, std::uint64_t tex, std::uint64_t frame) {
  m->canvas_item_create(item, frame);
  m->set_parent(item, kRootCanvas, frame);
  m->set_draw_index(item, static_cast<std::int32_t>(item), frame);
  m->add_texture_rect(item, kRect, tex, false, kWhite, false, frame);
}

grc::rs::PayloadCopy refused_copy() {
  grc::rs::PayloadCopy copy;
  copy.status = "unsupported";
  copy.reason = "unsupported-format";
  copy.format = 19;
  copy.width = 4;
  copy.height = 4;
  return copy;
}

// --- not live ---------------------------------------------------------------------------------

void test_not_live_keeps_non_root_typing() {
  Mirror m;
  bind_root(&m, false);
  check(!m.viewports_live(), "not live by default");
  m.canvas_create(kCanvas2, 1);
  const std::uint64_t epoch = m.epoch();
  m.viewport_create(kVpA, 1);
  m.viewport_get_texture(kVpA, 0x77, 1);
  m.viewport_set_size(kVpA, 64, 64, 1);
  m.viewport_set_active(kVpA, true, 1);
  m.viewport_set_update_mode(kVpA, 1, 1);
  m.viewport_set_use_hdr_2d(kVpA, true, 1);
  m.viewport_set_msaa_2d(kVpA, 2, 1);
  m.viewport_attach_camera(kVpA, kCamera, 1);
  m.viewport_set_scenario(kVpA, kScenario, 1);
  m.instance_set_scenario(kInstance, kScenario, 1);
  m.texture_proxy_create(0x6001, 0, kVpA, 1);
  m.texture_proxy_update(0x6001, 0, kVpA, 1);
  Mirror::AdoptedViewport a;
  a.rid = kVpB;
  a.default_proxy = 0x6002;
  m.adopt_viewport(a, 1);
  m.adopt_proxy(0x6003, 0, kVpB, 1);
  check(m.epoch() == epoch, "the new taps leave the epoch alone when not live");
  check(!m.knows_texture(0x6001) && !m.knows_texture(0x6002) && !m.knows_texture(0x6003),
        "no proxy entry when not live");
  // The generalized handlers keep /15's typing.
  m.viewport_attach_canvas(kVpA, kCanvas2, 2);
  m.viewport_set_canvas_stacking(kVpA, kCanvas2, 1, 0, 2);
  m.viewport_set_texture_filter(kVpA, 1, 2);
  Snapshot s = m.snapshot(1, 2).state;
  check(s.viewports.empty(), "no viewport table when not live");
  check(s.textures.size() == 0, "no viewport or proxy texture when not live");
  check(s.failures.empty(), "no failure when not live");
  check(has_session_entry(s, "viewport_attach_canvas", UnsupportedReason::NonRootViewport) &&
            has_session_entry(s, "viewport_set_canvas_stacking",
                              UnsupportedReason::NonRootViewport) &&
            has_session_entry(s, "viewport_set_default_canvas_item_texture_filter",
                              UnsupportedReason::NonRootViewport),
        "non-root-viewport typing kept when not live");
  for (const auto &u : s.unsupported) {
    check(u.reason != UnsupportedReason::Viewport3d && u.reason != UnsupportedReason::ViewportHdr2d &&
              u.reason != UnsupportedReason::ViewportMsaa2d,
          "no viewport-* reason when not live");
  }
  const grc::rs::MirrorStats st = m.stats();
  check(st.created == 0 && st.adopted == 0 && st.proxies == 0 && st.unknown_viewport_calls == 0,
        "no viewport counters when not live");
  // set_viewports survives reset().
  m.set_viewports(true);
  m.reset();
  check(m.viewports_live(), "set_viewports survives reset()");
}

// --- live: the table ----------------------------------------------------------------------------

void test_create_fields_and_order() {
  Mirror m;
  bind_root(&m, true);
  m.texture_2d_placeholder_create(0x7001, 1);  // texture 1: the counter is shared
  m.viewport_create(kVpA, 1);                   // viewport 1, texture 2
  m.viewport_create(kVpB, 1);                   // viewport 2, texture 3
  Snapshot s = m.snapshot(1, 1).state;
  check(s.viewports.size() == 2 && s.viewports[0].id == 1 && s.viewports[1].id == 2,
        "two viewports, ids from 1, sorted");
  const ViewportEntry *a = vp(s, 1);
  if (a != nullptr) {
    check(a->origin == Origin::Created && !a->has_parent && !a->active && a->active_seq == 0 &&
              a->size_w == 0 && a->size_h == 0 && !a->transparent &&
              a->update == ViewportUpdate::WhenVisible && a->once_seq == 0 &&
              a->clear == ViewportClear::Always && a->clear_seq == 0 && !a->disable_2d &&
              !a->renders_3d && !a->hdr_2d && a->msaa_2d == 0 &&
              a->canvas_cull_mask == 0xFFFFFFFFu && a->default_texture_filter == Filter::Linear &&
              a->default_texture_repeat == Repeat::Disabled && !a->snap_2d_transforms &&
              !a->snap_2d_vertices && a->canvases.empty() && a->global_xform == kIdentity,
          "a new viewport carries RendererViewport's defaults");
  }
  const auto *t2 = texture(s, 2);
  const auto *t3 = texture(s, 3);
  check(t2 != nullptr && t2->kind == TextureKind::Viewport && t2->status == TextureStatus::Ok &&
            t2->viewport == 1 && !t2->has_hash && t2->width == 0 && t2->payload_bytes == 0 &&
            t2->variants.empty() && t2->origin == Origin::Created,
        "viewport 1's texture: kind viewport, id from the shared counter");
  check(t3 != nullptr && t3->viewport == 2, "viewport 2's texture");
  check(s.failures.empty() && s.unsupported.empty(), "nothing typed");

  // size, activation order, parent, nesting
  m.viewport_set_size(kVpA, 256, 128, 2);
  m.viewport_set_size(kVpA, -1, 4, 2);  // refused
  m.viewport_set_active(kVpB, true, 2);  // seq 1
  m.viewport_set_active(kVpA, true, 2);  // seq 2
  m.viewport_set_active(kVpA, true, 2);  // already active: refused
  m.viewport_set_parent_viewport(kVpA, kRootViewport, 2);
  m.viewport_set_parent_viewport(kVpB, kVpA, 2);
  s = m.snapshot(2, 2).state;
  a = vp(s, 1);
  const ViewportEntry *b = vp(s, 2);
  check(a != nullptr && a->size_w == 256 && a->size_h == 128, "size, a negative size refused");
  check(b != nullptr && b->active && b->active_seq == 1 && a->active && a->active_seq == 2,
        "activation order; re-activating an active viewport keeps its seq");
  check(a->has_parent && a->parent == 0, "the root viewport is parent 0");
  check(b->has_parent && b->parent == 1, "a nested viewport names its parent's id");
  m.viewport_set_active(kVpB, false, 3);
  m.viewport_set_active(kVpB, true, 3);  // seq 3
  m.viewport_set_parent_viewport(kVpB, 0, 3);
  s = m.snapshot(3, 3).state;
  b = vp(s, 2);
  check(b->active && b->active_seq == 3, "a re-activation takes the next seq");
  check(!b->has_parent, "RID() parent is null");

  // update / clear modes and their sequences, flags
  m.viewport_set_update_mode(kVpA, 1, 4);  // once
  m.viewport_set_update_mode(kVpA, 1, 4);  // once again
  m.viewport_set_update_mode(kVpA, 9, 4);  // out of range: ignored
  m.viewport_set_clear_mode(kVpA, 2, 4);   // next_frame
  m.viewport_set_clear_mode(kVpA, 1, 4);   // never
  m.viewport_set_clear_mode(kVpA, -1, 4);  // ignored
  m.viewport_set_canvas_cull_mask(kVpA, 0x5, 4);
  m.viewport_set_transparent_background(kVpA, true, 4);
  m.viewport_set_disable_2d(kVpA, true, 4);
  m.viewport_set_snap_2d_transforms(kVpA, true, 4);
  m.viewport_set_snap_2d_vertices(kVpB, true, 4);
  m.viewport_set_texture_filter(kVpA, 0, 4);  // default: refused
  m.viewport_set_texture_filter(kVpA, 1, 4);  // nearest
  m.viewport_set_texture_repeat(kVpA, 2, 4);  // mirror? (1 enabled, 2 mirror)
  s = m.snapshot(4, 4).state;
  a = vp(s, 1);
  check(a->update == ViewportUpdate::Once && a->once_seq == 2, "once twice: once_seq 2");
  check(a->clear == ViewportClear::Never && a->clear_seq == 1, "next_frame once: clear_seq 1");
  check(a->canvas_cull_mask == 0x5 && a->transparent && a->disable_2d && a->snap_2d_transforms &&
            !a->snap_2d_vertices && vp(s, 2)->snap_2d_vertices,
        "cull mask, transparent, disable_2d, snap flags");
  check(a->default_texture_filter == Filter::Nearest &&
            a->default_texture_repeat == static_cast<Repeat>(2),
        "the viewport's own defaults; Default refused");
  check(s.default_texture_filter == Filter::Linear, "the root's default untouched");
  m.viewport_set_update_mode(kVpA, 4, 5);  // always: once_seq stays
  s = m.snapshot(5, 5).state;
  check(vp(s, 1)->update == ViewportUpdate::Always && vp(s, 1)->once_seq == 2,
        "leaving once keeps once_seq");

  // The root viewport is ignored by the new taps; an unknown viewport is pre-existing-object.
  m.viewport_set_size(kRootViewport, 9, 9, 6);
  m.viewport_set_active(kRootViewport, true, 6);
  s = m.snapshot(6, 6).state;
  check(s.viewports.size() == 2 && s.failures.empty(), "root calls are ignored by the new taps");
  m.viewport_set_size(0x9999, 1, 1, 7);
  s = m.snapshot(7, 7).state;
  check(has_failure(s, FailureReason::PreExistingObject) && m.stats().unknown_viewport_calls == 1,
        "an unknown viewport is the unknown-RID rule (Strict: pre-existing-object)");
  check(m.stats().created == 2, "created counts viewport_create");
}

void test_canvases_rows_and_unknown() {
  Mirror m;
  bind_root(&m, true);
  m.canvas_create(kCanvas3, 1);  // canvas 2
  m.canvas_create(kCanvas2, 1);  // canvas 3
  m.viewport_create(kVpA, 1);
  m.viewport_attach_canvas(kVpA, kCanvas2, 1);   // canvas 3 first
  m.viewport_attach_canvas(kVpA, kRootCanvas, 1);  // the root canvas, shared (World2D)
  m.viewport_attach_canvas(kVpA, kCanvas3, 1);
  m.viewport_set_canvas_stacking(kVpA, kCanvas2, 4, 1, 1);
  m.viewport_set_canvas_transform(kVpA, kCanvas2, {2, 0, 0, 2, 7, 8}, 1);
  m.viewport_attach_canvas(kVpA, kCanvas2, 1);  // already attached: refused, stacking kept
  m.viewport_set_global_canvas_transform(kVpA, {1, 0, 0, 1, 3, 4}, 1);
  Snapshot s = m.snapshot(1, 1).state;
  const ViewportEntry *a = vp(s, 1);
  check(a != nullptr && a->canvases.size() == 3, "three rows");
  if (a != nullptr && a->canvases.size() == 3) {
    check(a->canvases[0].canvas == 1 && a->canvases[1].canvas == 2 && a->canvases[2].canvas == 3,
          "rows sorted by canvas id");
    check(a->canvases[0].layer == 0 && a->canvases[0].sublayer == 0 &&
              a->canvases[0].xform == kIdentity,
          "an attach starts at stacking (0,0) and the identity transform");
    check(a->canvases[2].layer == 4 && a->canvases[2].sublayer == 1 &&
              a->canvases[2].xform == Xform({2, 0, 0, 2, 7, 8}),
          "stacking and transform on the row; a second attach keeps them");
    check(a->global_xform == Xform({1, 0, 0, 1, 3, 4}), "the viewport's global transform");
  }
  const auto *root = &s.canvases[0];
  check(root->id == 1 && root->attached, "the root canvas stays attached to the root");
  check(!s.canvases[1].attached && !s.canvases[2].attached,
        "a canvas attached only to a viewport has attached false");
  check(s.unsupported.empty() && s.failures.empty(), "no non-root-viewport under live");
  // A transform or stacking for a canvas not on the viewport is refused.
  m.canvas_create(0x4004, 2);
  m.viewport_set_canvas_transform(kVpA, 0x4004, {9, 9, 9, 9, 9, 9}, 2);
  m.viewport_set_canvas_stacking(kVpA, 0x4004, 9, 9, 2);
  m.viewport_remove_canvas(kVpA, kCanvas3, 2);
  s = m.snapshot(2, 2).state;
  a = vp(s, 1);
  check(a->canvases.size() == 2 && a->canvases[0].canvas == 1 && a->canvases[1].canvas == 3,
        "remove erases the row; an unattached canvas's transform is refused");
  // A freed canvas leaves every viewport, the root canvas included.
  m.free_rid(kCanvas2, 3);
  m.free_rid(kRootCanvas, 3);
  s = m.snapshot(3, 3).state;
  check(vp(s, 1)->canvases.empty(), "freed canvases leave the viewport's rows");
  // Root behaviour unchanged.
  m.canvas_create(0x4005, 4);
  m.viewport_attach_canvas(kRootViewport, 0x4005, 4);
  s = m.snapshot(4, 4).state;
  check(s.canvases.back().attached && vp(s, 1)->canvases.empty(), "a root attach stays the root's");
  // Live and unknown: never non-root-viewport.
  m.viewport_attach_canvas(0x9999, 0x4005, 5);
  s = m.snapshot(5, 5).state;
  check(has_failure(s, FailureReason::PreExistingObject) &&
            !has_session_entry(s, "viewport_attach_canvas", UnsupportedReason::NonRootViewport),
        "an unknown viewport under live: pre-existing-object, not non-root-viewport");

  // Skip: counted, not a failure.
  Mirror k;
  bind_root(&k, true);
  k.set_unknown_item_policy(grc::rs2::UnknownItemPolicy::Skip);
  k.canvas_create(kCanvas2, 1);
  k.viewport_attach_canvas(0x9999, kCanvas2, 1);
  k.viewport_set_global_canvas_transform(0x9999, kIdentity, 1);
  k.viewport_set_size(0x9999, 4, 4, 1);
  s = k.snapshot(1, 1).state;
  check(s.failures.empty() && k.stats().unknown_viewport_calls == 3 &&
            k.stats().unknown_calls == 3,
        "Skip: unknown viewport calls are counted, not failures");
}

void test_3d_hdr_msaa() {
  Mirror m;
  bind_root(&m, true);
  m.viewport_create(kVpA, 1);
  m.viewport_attach_camera(kVpA, kCamera, 1);
  m.viewport_set_scenario(kVpA, kScenario, 1);
  Snapshot s = m.snapshot(1, 1).state;
  check(!vp(s, 1)->renders_3d &&
            !has_session_entry(s, "viewport_attach_camera", UnsupportedReason::Viewport3d),
        "a camera over an empty scenario is not 3D");
  m.instance_set_scenario(kInstance, kScenario, 2);
  s = m.snapshot(2, 2).state;
  check(vp(s, 1)->renders_3d &&
            has_session_entry(s, "viewport_attach_camera", UnsupportedReason::Viewport3d),
        "an instance in the scenario: renders_3d and viewport-3d");
  m.viewport_set_disable_3d(kVpA, true, 3);
  s = m.snapshot(3, 3).state;
  check(!vp(s, 1)->renders_3d &&
            has_session_entry(s, "viewport_attach_camera", UnsupportedReason::Viewport3d),
        "disable_3d clears renders_3d; the session entry is sticky");
  m.viewport_set_disable_3d(kVpA, false, 4);
  m.free_rid(kInstance, 4);  // the instance leaves its scenario
  s = m.snapshot(4, 4).state;
  check(!vp(s, 1)->renders_3d, "a freed instance leaves the scenario");
  m.instance_set_scenario(kInstance + 1, kScenario, 5);
  m.viewport_attach_camera(kVpA, 0, 5);
  s = m.snapshot(5, 5).state;
  check(!vp(s, 1)->renders_3d, "no camera: not 3D");
  m.viewport_attach_camera(kVpA, kCamera, 6);
  m.instance_set_scenario(kInstance + 1, 0, 6);
  s = m.snapshot(6, 6).state;
  check(!vp(s, 1)->renders_3d, "an instance moved out of the scenario");
  check(m.stats().renders_3d == 1, "renders_3d counts viewports that ever rendered 3D");
  // hdr / msaa
  m.viewport_set_use_hdr_2d(kVpA, false, 7);
  m.viewport_set_msaa_2d(kVpA, 0, 7);
  m.viewport_set_msaa_2d(kVpA, 4, 7);  // MSAA_MAX: refused
  s = m.snapshot(7, 7).state;
  check(!has_session_entry(s, "viewport_set_use_hdr_2d", UnsupportedReason::ViewportHdr2d) &&
            !has_session_entry(s, "viewport_set_msaa_2d", UnsupportedReason::ViewportMsaa2d) &&
            vp(s, 1)->msaa_2d == 0,
        "hdr false and msaa 0 add nothing; msaa 4 refused");
  m.viewport_set_use_hdr_2d(kVpA, true, 8);
  m.viewport_set_msaa_2d(kVpA, 2, 8);
  m.viewport_set_use_hdr_2d(kVpA, false, 9);
  s = m.snapshot(8, 9).state;
  check(has_session_entry(s, "viewport_set_use_hdr_2d", UnsupportedReason::ViewportHdr2d) &&
            has_session_entry(s, "viewport_set_msaa_2d", UnsupportedReason::ViewportMsaa2d),
        "hdr and msaa add their sticky session entries");
  check(!vp(s, 1)->hdr_2d && vp(s, 1)->msaa_2d == 2, "the entry carries the current flags");
  // A freed scenario takes its instances.
  m.instance_set_scenario(kInstance + 2, kScenario, 10);
  m.free_rid(kScenario, 10);
  s = m.snapshot(9, 10).state;
  check(!vp(s, 1)->renders_3d, "a freed scenario holds no instance");
}

// D9 late equals born: an adopted 3D viewport whose scenario held its instance before the arm. The
// hooks' pre-arm instance membership is seeded into the mirror at the arm, so a post-arm
// re-attach of the camera and the scenario (re-entering the tree) recomputes what a born mirror
// would, and freeing the pre-arm instance turns it off.
void test_3d_adopted_late_equals_born() {
  constexpr std::uint64_t kEmpty = 0x5009;
  // Born: the mirror saw the instance enter the scenario.
  Mirror born;
  bind_root(&born, true);
  born.instance_set_scenario(kInstance, kScenario, 1);
  born.viewport_create(kVpA, 1);
  born.viewport_attach_camera(kVpA, kCamera, 1);
  born.viewport_set_scenario(kVpA, kScenario, 1);
  // Late: the instance is pre-arm; the walk adopts the viewport with its scenario.
  Mirror late;
  bind_root(&late, true);
  late.seed_scenario_instances({{kInstance, kScenario}}, 1);
  Mirror::AdoptedViewport a;
  a.rid = kVpA;
  a.active = true;
  a.has_camera = true;
  a.scenario = kScenario;
  a.renders_3d = true;
  late.adopt_viewport(a, 1);
  const auto r3d = [](Mirror &m, std::uint64_t frame) {
    const Snapshot s = m.snapshot(frame, frame).state;
    return vp(s, 1) != nullptr && vp(s, 1)->renders_3d;
  };
  check(r3d(born, 1) && r3d(late, 1), "late = born: adopted with a pre-arm instance, 3D");
  for (Mirror *m : {&born, &late}) {  // re-enters the tree after the arm
    m->viewport_attach_camera(kVpA, kCamera, 2);
    m->viewport_set_scenario(kVpA, kScenario, 2);
  }
  check(r3d(born, 2) && r3d(late, 2),
        "late = born: camera and the same scenario named again after the arm stay 3D");
  for (Mirror *m : {&born, &late}) m->viewport_set_scenario(kVpA, kEmpty, 3);
  check(!r3d(born, 3) && !r3d(late, 3), "late = born: an empty scenario is not 3D");
  for (Mirror *m : {&born, &late}) m->viewport_set_scenario(kVpA, kScenario, 4);
  check(r3d(born, 4) && r3d(late, 4), "late = born: back to the occupied scenario");
  for (Mirror *m : {&born, &late}) m->free_rid(kInstance, 5);
  check(!r3d(born, 5) && !r3d(late, 5), "late = born: freeing the pre-arm instance ends 3D");
  // A camera over an empty world at the arm: an instance entering after the arm makes it 3D.
  Mirror late2;
  bind_root(&late2, true);
  Mirror::AdoptedViewport b = a;
  b.renders_3d = false;
  late2.adopt_viewport(b, 1);
  check(!r3d(late2, 1), "late: a camera over an empty scenario is not 3D");
  late2.instance_set_scenario(kInstance + 1, kScenario, 2);
  check(r3d(late2, 2), "late: an instance entering after the arm makes it 3D, as born");
  // Seeding never overrides a membership the mirror's own taps already hold.
  late2.seed_scenario_instances({{kInstance + 1, kEmpty}}, 3);
  check(r3d(late2, 3), "seed: an instance the mirror already places keeps its scenario");
}

// --- proxies ------------------------------------------------------------------------------------

void test_proxy_binding_and_node_route() {
  Mirror m;
  bind_root(&m, true);
  m.texture_2d_placeholder_create(0x7001, 1);  // texture 1
  m.viewport_create(kVpA, 1);                   // viewport 1, texture 2
  m.viewport_get_texture(kVpA, 0, 1);           // headless: RID()
  m.texture_proxy_create(0x6001, 0, kVpA, 1);   // texture 3: the constructor's adjacency
  m.viewport_create(kVpB, 1);                   // viewport 2, texture 4
  m.viewport_get_texture(kVpB, 0x8002, 1);      // rendered host: an rt RID
  m.texture_proxy_create(0x6002, 0x8002, 0, 1);  // texture 5: by rid
  m.texture_proxy_create(0x6003, 0x7001, 0, 1);  // texture 6: by texture
  m.texture_proxy_create(0x6004, 0x6003, 0, 1);  // texture 7: proxy of a proxy -> unresolved
  m.texture_proxy_create(0x6005, 0, 0, 1);       // texture 8: unresolved
  m.texture_proxy_create(0x6006, 0, 0, 1);       // texture 9: unresolved
  Snapshot s = m.snapshot(1, 1).state;
  const auto ok_proxy = [&](std::uint32_t id, std::uint32_t target, const std::string &what) {
    const auto *t = texture(s, id);
    check(t != nullptr && t->kind == TextureKind::Proxy && t->status == TextureStatus::Ok &&
              t->has_target && t->target == target && !t->has_reason && !t->has_hash &&
              t->width == 0 && t->payload_bytes == 0,
          what);
  };
  const auto unresolved = [&](std::uint32_t id, const std::string &what) {
    const auto *t = texture(s, id);
    check(t != nullptr && t->kind == TextureKind::Proxy &&
              t->status == TextureStatus::Unsupported && !t->has_target && t->has_reason &&
              t->reason == TextureReason::ProxyUnresolved,
          what);
  };
  ok_proxy(3, 2, "bound by adjacency to viewport 1's texture");
  ok_proxy(5, 4, "bound by render-target RID to viewport 2's texture");
  ok_proxy(6, 1, "bound to a known texture");
  unresolved(7, "a proxy of a proxy is unresolved");
  unresolved(8, "no route: unresolved");
  grc::rs::MirrorStats st = m.stats();
  check(st.proxies == 6 && st.proxies_bound_adjacency == 1 && st.proxies_bound_rid == 1 &&
            st.proxies_bound_texture == 1 && st.proxies_unresolved == 3 && st.unresolved_now == 3,
        "proxy counters");

  // The node route: only proxies a live item names, each once with one item.
  check(m.unresolved_proxy_uses().empty(), "no item names an unresolved proxy yet");
  drawing_item(&m, 0x100, 0x6005, 2);
  drawing_item(&m, 0x101, 0x6005, 2);
  drawing_item(&m, 0x102, 0x6006, 2);
  std::vector<Mirror::UnresolvedProxyUse> uses = m.unresolved_proxy_uses();
  check(uses.size() == 2 && uses[0].proxy == 0x6005 && uses[0].item == 0x100 &&
            uses[1].proxy == 0x6006 && uses[1].item == 0x102,
        "each named unresolved proxy once, with one naming item");
  m.proxy_node_route_result(0x6005, kVpB, 2);  // found
  m.proxy_node_route_result(0x6006, 0, 2);     // not found
  m.proxy_node_route_result(0x6006, kVpA, 2);  // already tried: ignored
  s = m.snapshot(2, 2).state;
  ok_proxy(8, 4, "the node route binds the proxy to viewport 2");
  check(texture(s, 8)->version == 2, "binding raises the version");
  unresolved(9, "not found: stays unresolved");
  check(texture(s, 9)->version == 1, "a failed route changes nothing on the wire");
  check(m.unresolved_proxy_uses().empty(), "a tried proxy is not returned again");
  st = m.stats();
  check(st.proxies_bound_node_route == 1 && st.node_route_tried == 2 && st.unresolved_now == 2,
        "node-route counters");

  // Re-pointing: version + 1, the route may try again after a re-point into unresolved.
  m.texture_proxy_update(0x6006, 0x7001, 0, 3);
  s = m.snapshot(3, 3).state;
  ok_proxy(9, 1, "re-pointed to a known texture");
  check(texture(s, 9)->version == 2, "re-pointing raises the version");
  m.texture_proxy_update(0x6006, 0x7001, 0, 4);  // the same target: no change
  m.texture_proxy_update(0x6003, 0, kVpA, 4);    // texture 6 to viewport 1's texture
  s = m.snapshot(4, 4).state;
  check(texture(s, 9)->version == 2, "an update to the same target keeps the version");
  ok_proxy(6, 2, "re-pointed by adjacency");
  check(texture(s, 6)->version == 2, "re-pointed: version 2");
  m.texture_proxy_update(0x6006, 0, 0, 5);  // back to unresolved
  s = m.snapshot(5, 5).state;
  unresolved(9, "re-pointed to nothing");
  check(texture(s, 9)->version == 3 && m.stats().proxies_unresolved == 4,
        "a transition into unresolved counts and raises the version");
  uses = m.unresolved_proxy_uses();
  check(uses.size() == 1 && uses[0].proxy == 0x6006, "re-pointed: the node route may try again");
  // texture_proxy_update on a non-proxy or an unknown RID changes nothing.
  const std::uint64_t epoch = m.epoch();
  m.texture_proxy_update(0x7001, 0, kVpA, 6);
  m.texture_proxy_update(0x6FFF, 0, kVpA, 6);
  s = m.snapshot(6, 6).state;
  check(texture(s, 1)->kind == TextureKind::Placeholder && texture(s, 1)->version == 1,
        "an update naming a non-proxy changes nothing");
  (void)epoch;
}

// The node route learns uses from events (a command, a parameter or a canvas texture diffuse
// naming an unresolved proxy, or a proxy turning unresolved under existing consumers), never by
// walking every item on each call: an unresolved proxy nothing names costs nothing per frame.
void test_node_route_uses_are_events() {
  constexpr std::uint64_t kImage = 0x7001, kProxy = 0x6100, kCanvasTex = 0x6200;
  constexpr std::size_t kItems = 300;
  Mirror m;
  bind_root(&m, true);
  m.texture_2d_placeholder_create(kImage, 1);
  for (std::size_t i = 0; i < kItems; ++i) {
    drawing_item(&m, 0x10000 + i, kImage, 1);
  }
  m.texture_proxy_create(kProxy, 0, 0, 1);  // unresolved, untried; nothing names it
  const std::uint64_t scanned = m.stats().node_route_scan_items;
  bool none = true;
  for (int frame = 2; frame < 12; ++frame) {
    none = none && m.unresolved_proxy_uses().empty();
  }
  check(none, "events: an unresolved proxy nothing names yields no use");
  check(m.stats().node_route_scan_items == scanned,
        "events: repeated calls walk no item (" +
            std::to_string(m.stats().node_route_scan_items - scanned) + " visited)");
  // A consumer with no item (a canvas texture's diffuse) queues one use without an item.
  m.canvas_texture_create(kCanvasTex, 12);
  m.canvas_texture_set_channel(kCanvasTex, 0, kProxy, 12);
  std::vector<Mirror::UnresolvedProxyUse> uses = m.unresolved_proxy_uses();
  check(uses.size() == 1 && uses[0].proxy == kProxy && uses[0].item == 0,
        "events: a diffuse consumer queues one use, with no item");
  check(m.unresolved_proxy_uses().empty(), "events: a use is returned once");
  // A later draw queues exactly one use, with its item, however many items draw it.
  drawing_item(&m, 0x20000, kProxy, 13);
  drawing_item(&m, 0x20001, kProxy, 13);
  uses = m.unresolved_proxy_uses();
  check(uses.size() == 1 && uses[0].proxy == kProxy && uses[0].item == 0x20000,
        "events: a later draw queues exactly one use with the first drawing item");
  check(m.unresolved_proxy_uses().empty(), "events: and only once");
  // Tried and not found: a further draw is not a retry.
  m.proxy_node_route_result(kProxy, 0, 14);
  drawing_item(&m, 0x20002, kProxy, 14);
  check(m.unresolved_proxy_uses().empty(), "events: a tried proxy's new draw is not a retry");
  // Re-pointed into unresolved: the existing consumers are found once, at the re-point.
  const std::uint64_t before = m.stats().node_route_scan_items;
  m.texture_proxy_update(kProxy, 0, 0, 15);
  uses = m.unresolved_proxy_uses();
  check(uses.size() == 1 && uses[0].proxy == kProxy && uses[0].item == 0x20000,
        "events: a re-point into unresolved queues an existing consumer");
  const std::uint64_t after = m.stats().node_route_scan_items;
  check(after - before <= kItems + 3, "events: the re-point scans the items at most once");
  for (int frame = 16; frame < 26; ++frame) m.unresolved_proxy_uses();
  check(m.stats().node_route_scan_items == after, "events: and later calls walk nothing");
  // Bound (ok) and back: an ok proxy queues nothing, a transition from ok scans once.
  m.texture_proxy_update(kProxy, kImage, 0, 26);
  drawing_item(&m, 0x20003, kProxy, 26);
  check(m.unresolved_proxy_uses().empty(), "events: an ok proxy queues no use");
  m.texture_proxy_update(kProxy, 0, 0, 27);
  uses = m.unresolved_proxy_uses();
  check(uses.size() == 1 && uses[0].proxy == kProxy && uses[0].item == 0x20000,
        "events: ok -> unresolved under consumers queues one use");
}

void test_proxy_tombstones_and_replace() {
  Mirror m;
  bind_root(&m, true);
  m.texture_2d_placeholder_create(0x7001, 1);  // texture 1
  m.texture_proxy_create(0x6001, 0x7001, 0, 1);  // texture 2 -> 1
  m.free_rid(0x7001, 2);
  Snapshot s = m.snapshot(1, 2).state;
  check(texture(s, 1) != nullptr && texture(s, 1)->status == TextureStatus::Freed,
        "a proxy keeps a freed target as a tombstone");
  check(texture(s, 2)->status == TextureStatus::Ok && texture(s, 2)->target == 1,
        "the proxy still names it");
  m.free_rid(0x6001, 3);  // nothing names the proxy: gone; then the target's tombstone goes too
  s = m.snapshot(2, 3).state;
  check(texture(s, 2) == nullptr, "a freed proxy no command names leaves the table");
  s = m.snapshot(3, 3).state;
  check(texture(s, 1) == nullptr, "the target's tombstone leaves once nothing names it");

  // A freed proxy a command names is a tombstone keeping its target key.
  m.texture_2d_placeholder_create(0x7002, 4);    // texture 3
  m.texture_proxy_create(0x6002, 0x7002, 0, 4);  // texture 4
  drawing_item(&m, 0x100, 0x6002, 4);
  m.free_rid(0x6002, 5);
  s = m.snapshot(4, 5).state;
  const auto *t4 = texture(s, 4);
  check(t4 != nullptr && t4->status == TextureStatus::Freed && t4->kind == TextureKind::Proxy &&
            t4->has_target && t4->target == 3 && !t4->has_reason,
        "a freed proxy keeps its last target");

  // texture_replace redirects the by-texture's proxies; a proxy is never replaced.
  m.texture_2d_placeholder_create(0x7003, 6);    // texture 5
  m.texture_2d_placeholder_create(0x7004, 6);    // texture 6
  m.texture_proxy_create(0x6003, 0x7004, 0, 6);  // texture 7 -> 6
  m.texture_replace(0x7003, 0x7004, 7);
  s = m.snapshot(5, 7).state;
  check(texture(s, 7)->target == 5 && texture(s, 7)->version == 2,
        "texture_replace(t, b) re-points b's proxies to t");
  check(texture(s, 6) == nullptr, "b leaves (no command names it)");
  const std::uint64_t before = texture(s, 5)->version;
  m.texture_replace(0x6003, 0x7003, 8);
  m.texture_replace(0x7003, 0x6003, 8);
  m.texture_2d_update(0x6003, refused_copy(), nullptr, 0, 8);
  s = m.snapshot(6, 8).state;
  check(texture(s, 5)->version == before && texture(s, 7)->status == TextureStatus::Ok &&
            texture(s, 7)->version == 2,
        "a proxy is never replaced, replaced by, or updated");
}

void test_viewport_free() {
  Mirror m;
  bind_root(&m, true);
  m.viewport_create(kVpA, 1);                  // viewport 1, texture 1
  m.viewport_get_texture(kVpA, 0x8001, 1);
  m.viewport_create(kVpB, 1);                  // viewport 2, texture 2
  m.viewport_set_parent_viewport(kVpB, kVpA, 1);
  m.viewport_create(kVpC, 1);                  // viewport 3, texture 3
  m.texture_proxy_create(0x6001, 0, kVpA, 1);  // texture 4 -> 1
  Snapshot s = m.snapshot(1, 1).state;
  check(s.viewports.size() == 3, "three viewports");
  m.free_rid(kVpA, 2);
  m.free_rid(kVpC, 2);
  s = m.snapshot(2, 2).state;
  check(s.viewports.size() == 1 && s.viewports[0].id == 2, "freed viewports leave the table");
  check(!s.viewports[0].has_parent, "a child of a freed viewport has a null parent");
  check(texture(s, 1) != nullptr && texture(s, 1)->status == TextureStatus::Freed &&
            texture(s, 1)->viewport == 1,
        "a freed viewport's texture a proxy names: a tombstone keeping its viewport key");
  check(texture(s, 3) == nullptr, "a freed viewport's unnamed texture leaves in the same snapshot");
  check(texture(s, 4)->status == TextureStatus::Ok && texture(s, 4)->target == 1,
        "the proxy keeps naming the tombstone");
  check(m.stats().freed == 2, "freed counts viewports");
  // The render-target map left with the viewport; its RID binds nothing now.
  m.texture_proxy_create(0x6002, 0x8001, 0, 3);
  s = m.snapshot(3, 3).state;
  check(texture(s, 5) != nullptr && texture(s, 5)->status == TextureStatus::Unsupported,
        "a freed viewport's render-target RID no longer binds");
  // Calls on a freed viewport RID are unknown (Skip: counted).
  Mirror k;
  bind_root(&k, true);
  k.set_unknown_item_policy(grc::rs2::UnknownItemPolicy::Skip);
  k.viewport_create(kVpA, 1);
  k.free_rid(kVpA, 1);
  k.viewport_set_size(kVpA, 1, 1, 2);
  check(k.stats().unknown_viewport_calls == 1, "a freed viewport is unknown");
  // A recycled RID value is a new viewport.
  k.viewport_create(kVpA, 3);
  s = k.snapshot(1, 3).state;
  check(s.viewports.size() == 1 && s.viewports[0].id == 2, "ids are never reused");
}

void test_derived_unsupported_through_proxy() {
  Mirror m;
  bind_root(&m, true);
  m.texture_2d_create(0x7001, refused_copy(), nullptr, 1);  // texture 1: unsupported
  m.texture_2d_placeholder_create(0x7002, 1);               // texture 2: ok
  m.texture_proxy_create(0x6001, 0x7001, 0, 1);             // texture 3 -> 1 (unsupported)
  m.canvas_texture_create(0x7003, 1);                       // texture 4: canvas
  m.canvas_texture_set_channel(0x7003, 0, 0x6001, 1);       // diffuse: the proxy
  m.texture_proxy_create(0x6002, 0, 0, 1);                  // texture 5: unresolved
  m.texture_proxy_create(0x6003, 0x7003, 0, 1);             // texture 6 -> canvas 4
  drawing_item(&m, 0x100, 0x6001, 1);  // item 1: tex an ok proxy of an unsupported entry
  drawing_item(&m, 0x101, 0x7003, 1);  // item 2: a canvas texture whose diffuse is such a proxy
  drawing_item(&m, 0x102, 0x6002, 1);  // item 3: an unsupported proxy
  drawing_item(&m, 0x103, 0x6003, 1);  // item 4: proxy -> canvas -> diffuse proxy -> unsupported
  m.canvas_item_create(0x104, 1);      // item 5: add_texture_rect_region through the proxy
  m.set_parent(0x104, kRootCanvas, 1);
  m.set_draw_index(0x104, 0x104, 1);
  m.add_texture_rect_region(0x104, kRect, 0x6001, kRect, kWhite, false, false, 1);
  Snapshot s = m.snapshot(1, 1).state;
  const std::string rect = "canvas_item_add_texture_rect";
  check(has_item_entry(s, 1, rect, UnsupportedReason::UnsupportedTexture),
        "an ok proxy of an unsupported entry: unsupported-texture");
  check(has_item_entry(s, 2, rect, UnsupportedReason::UnsupportedTexture),
        "a canvas texture whose diffuse is an ok proxy of an unsupported entry");
  check(has_item_entry(s, 3, rect, UnsupportedReason::UnsupportedTexture),
        "an unsupported proxy is an unsupported entry");
  check(has_item_entry(s, 4, rect, UnsupportedReason::UnsupportedTexture),
        "proxy -> canvas texture -> diffuse proxy: one hop each");
  check(has_item_entry(s, 5, "canvas_item_add_texture_rect_region",
                       UnsupportedReason::UnsupportedTexture),
        "add_texture_rect_region reads through the proxy too");
  // Re-pointing the proxy to an ok texture clears the derived entries (incremental publish).
  m.texture_proxy_update(0x6001, 0x7002, 0, 2);
  m.proxy_node_route_result(0x6002, 0, 2);
  m.texture_proxy_update(0x6002, 0x7002, 0, 2);
  s = m.snapshot(2, 2).state;
  for (std::uint32_t item = 1; item <= 5; ++item) {
    check(!has_item_entry(s, item, rect, UnsupportedReason::UnsupportedTexture) &&
              !has_item_entry(s, item, "canvas_item_add_texture_rect_region",
                              UnsupportedReason::UnsupportedTexture),
          "re-pointed to an ok texture: no derived entry for item " + std::to_string(item));
  }
  // The target turning unsupported moves the derived entries back.
  m.texture_2d_update(0x7002, refused_copy(), nullptr, 1, 3);  // layered: unsupported
  s = m.snapshot(3, 3).state;
  check(has_item_entry(s, 1, rect, UnsupportedReason::UnsupportedTexture) &&
            has_item_entry(s, 3, rect, UnsupportedReason::UnsupportedTexture),
        "the target turning unsupported derives the entry through the proxy");
}

void test_adoption() {
  Mirror m;
  bind_root(&m, true);
  Mirror::AdoptedViewport a;
  a.rid = kVpA;
  a.parent = kRootViewport;
  a.active = true;
  a.width = 960;
  a.height = 1620;
  a.transparent = true;
  a.update_mode = 1;  // once
  a.clear_mode = 2;   // next_frame
  a.default_filter = 2;
  a.default_repeat = 3;
  a.snap_vertices = true;
  a.global_xform = {1, 0, 0, 1, 5, 6};
  a.default_proxy = 0x6001;
  m.adopt_viewport(a, 1);  // viewport 1, texture 1, proxy texture 2
  Mirror::AdoptedViewport b;
  b.rid = kVpB;
  b.parent = kVpA;
  b.active = true;
  b.update_mode = 4;
  b.renders_3d = true;
  b.hdr_2d = true;
  b.msaa_2d = 3;
  m.adopt_viewport(b, 1);  // viewport 2, texture 3
  m.adopt_viewport(b, 1);  // known: nothing
  m.adopt_proxy(0x6002, 0, kVpB, 1);   // texture 4 -> 3
  m.adopt_proxy(0x6003, 0, 0, 1);      // texture 5: unresolved
  Snapshot s = m.snapshot(1, 1).state;
  const ViewportEntry *va = vp(s, 1);
  const ViewportEntry *vb = vp(s, 2);
  check(s.viewports.size() == 2 && va != nullptr && vb != nullptr, "two adopted viewports");
  if (va == nullptr || vb == nullptr) return;
  check(va->origin == Origin::Adopted && va->has_parent && va->parent == 0 && va->active &&
            va->active_seq == 1 && va->size_w == 960 && va->size_h == 1620 && va->transparent &&
            va->update == ViewportUpdate::Once && va->once_seq == 1 &&
            va->clear == ViewportClear::NextFrame && va->clear_seq == 1 &&
            va->default_texture_filter == Filter::Linear &&
            va->default_texture_repeat == Repeat::Mirror && va->snap_2d_vertices &&
            va->global_xform == Xform({1, 0, 0, 1, 5, 6}),
        "adopted fields; once -> once_seq 1");
  check(vb->has_parent && vb->parent == 1 && vb->active_seq == 2 && vb->renders_3d &&
            vb->hdr_2d && vb->msaa_2d == 3,
        "the child: parent, activation in call order, 3D, hdr, msaa");
  check(has_session_entry(s, "viewport_attach_camera", UnsupportedReason::Viewport3d) &&
            has_session_entry(s, "viewport_set_use_hdr_2d", UnsupportedReason::ViewportHdr2d) &&
            has_session_entry(s, "viewport_set_msaa_2d", UnsupportedReason::ViewportMsaa2d),
        "adopted 3D, hdr and msaa add the session entries");
  const auto *t1 = texture(s, 1);
  const auto *t2 = texture(s, 2);
  check(t1 != nullptr && t1->kind == TextureKind::Viewport && t1->origin == Origin::Adopted &&
            t1->adopted_content == grc::rs2::AdoptedContent::Current,
        "an adopted viewport texture is adopted/current");
  check(t2 != nullptr && t2->kind == TextureKind::Proxy && t2->status == TextureStatus::Ok &&
            t2->target == 1 && t2->origin == Origin::Adopted &&
            t2->adopted_content == grc::rs2::AdoptedContent::Current,
        "the default proxy is an adopted ok proxy of the viewport's texture");
  check(texture(s, 4)->target == 3 && texture(s, 5)->status == TextureStatus::Unsupported,
        "adopt_proxy resolves like create");
  const grc::rs::MirrorStats st = m.stats();
  check(st.adopted == 2 && st.proxies == 3 && st.proxies_adopted == 2 &&
            st.proxies_unresolved == 1 && st.renders_3d == 1,
        "adoption counters");
  // After adoption, a real camera/scenario call recomputes 3D from what the hooks saw.
  m.viewport_set_disable_3d(kVpB, true, 2);
  s = m.snapshot(2, 2).state;
  check(!vp(s, 2)->renders_3d, "disable_3d clears an adopted renders_3d");
  m.viewport_set_disable_3d(kVpB, false, 3);
  s = m.snapshot(3, 3).state;
  check(vp(s, 2)->renders_3d, "re-enabled: the adopted camera and world still stand");
  m.viewport_set_scenario(kVpB, kScenario, 4);  // an empty world now
  s = m.snapshot(4, 4).state;
  check(!vp(s, 2)->renders_3d, "a real scenario replaces the adopted world");
}

// --- the wire -----------------------------------------------------------------------------------

grc::rs2::Session session16(bool adoption) {
  grc::rs2::Session s;
  s.version = grc::rs2::ProtocolVersion::V16;
  s.session_id = std::string(32, '1');
  s.stream.stream_id = std::string(32, '2');
  s.stream.encoding = grc::rs2::Encoding::Patch;
  s.viewports = grc::rs2::ViewportsMode::On;
  s.adoption.present = adoption;
  s.adoption.frame = 1;
  return s;
}

grc::rs2::End make_end(std::uint64_t full_count, std::uint64_t patch_count,
                       const std::vector<std::vector<std::uint8_t>> &records) {
  grc::rs2::End end;
  end.transactions = full_count + patch_count;
  end.reason = grc::rs2::EndReason::Shutdown;
  end.stats.full_transactions = full_count;
  end.stats.patch_transactions = patch_count;
  std::uint64_t bytes_total = 0;
  std::uint64_t max_len = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    bytes_total += records[i].size();
    if (i > 0) max_len = std::max<std::uint64_t>(max_len, records[i].size());
  }
  end.stats.bytes_total = bytes_total;
  end.stats.max_record_bytes = max_len;
  return end;
}

void test_wire_roundtrip(const char *out_path) {
  Mirror m;
  bind_root(&m, true);
  // Adopted at arm: a viewport with its default proxy.
  Mirror::AdoptedViewport a;
  a.rid = kVpA;
  a.parent = kRootViewport;
  a.active = true;
  a.width = 64;
  a.height = 64;
  a.default_proxy = 0x6001;
  m.adopt_viewport(a, 1);
  m.canvas_create(kCanvas2, 1);
  m.viewport_attach_canvas(kVpA, kCanvas2, 1);
  m.viewport_attach_canvas(kVpA, kRootCanvas, 1);  // shared with the root
  m.viewport_set_canvas_transform(kVpA, kCanvas2, {1, 0, 0, 1, 2, 3}, 1);
  drawing_item(&m, 0x100, 0x6001, 1);  // the root draws the surface

  std::vector<Snapshot> snaps;
  snaps.push_back(m.snapshot(1, 1).state);
  // Frame 2: a nested created viewport, a resize, once, a proxy re-point, a derived entry.
  m.viewport_create(kVpB, 2);
  m.viewport_get_texture(kVpB, 0, 2);
  m.texture_proxy_create(0x6002, 0, kVpB, 2);
  m.viewport_set_parent_viewport(kVpB, kVpA, 2);
  m.viewport_set_active(kVpB, true, 2);
  m.viewport_set_size(kVpB, 16, 8, 2);
  m.viewport_set_update_mode(kVpB, 1, 2);
  m.viewport_attach_canvas(kVpB, kCanvas2, 2);
  m.viewport_set_size(kVpA, 128, 64, 2);
  m.texture_2d_create(0x7001, refused_copy(), nullptr, 2);
  m.texture_proxy_create(0x6003, 0x7001, 0, 2);
  drawing_item(&m, 0x101, 0x6003, 2);
  m.texture_proxy_create(0x6004, 0, 0, 2);  // unresolved, drawn
  drawing_item(&m, 0x102, 0x6004, 2);
  snaps.push_back(m.snapshot(2, 2).state);
  // Frame 3: the 3D flag, hdr, a stacking change, the node route binds the unresolved proxy.
  m.viewport_attach_camera(kVpB, kCamera, 3);
  m.viewport_set_scenario(kVpB, kScenario, 3);
  m.instance_set_scenario(kInstance, kScenario, 3);
  m.viewport_set_use_hdr_2d(kVpA, true, 3);
  m.viewport_set_canvas_stacking(kVpA, kCanvas2, 2, 0, 3);
  m.proxy_node_route_result(0x6004, kVpB, 3);
  m.texture_proxy_update(0x6003, 0, kVpA, 3);  // re-point
  snaps.push_back(m.snapshot(3, 3).state);
  // Frame 4: free the nested viewport (its texture kept by the proxy naming it), free a canvas.
  m.free_rid(kVpB, 4);
  m.free_rid(kCanvas2, 4);
  snaps.push_back(m.snapshot(4, 4).state);
  // Frame 5: free the proxies naming the tombstone (texture 3); it leaves.
  m.free_rid(0x6002, 5);
  m.clear(0x102, 5);
  m.free_rid(0x6004, 5);
  snaps.push_back(m.snapshot(5, 5).state);
  snaps.push_back(m.snapshot(6, 6).state);

  check(snaps[1].viewports.size() == 2 && snaps[3].viewports.size() == 1,
        "the table grows and shrinks");
  check(texture(snaps[3], 3) != nullptr && texture(snaps[3], 3)->status == TextureStatus::Freed &&
            texture(snaps[3], 3)->kind == TextureKind::Viewport,
        "the freed viewport's texture is a tombstone while a proxy names it");
  check(texture(snaps[5], 3) == nullptr, "and leaves once nothing names it");
  check(has_item_entry(snaps[1], 2, "canvas_item_add_texture_rect",
                       UnsupportedReason::UnsupportedTexture) &&
            has_item_entry(snaps[1], 3, "canvas_item_add_texture_rect",
                           UnsupportedReason::UnsupportedTexture) &&
            !has_item_entry(snaps[2], 2, "canvas_item_add_texture_rect",
                            UnsupportedReason::UnsupportedTexture) &&
            !has_item_entry(snaps[2], 3, "canvas_item_add_texture_rect",
                            UnsupportedReason::UnsupportedTexture),
        "derived entries through proxies appear and clear on the wire's snapshots");

  grc::rs13::Predictor predictor;
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(grc::rs2::magic(grc::rs2::ProtocolVersion::V16));
  records.push_back(grc::rs2::encode_session(session16(true)));
  Snapshot resolved;
  for (std::size_t i = 0; i < snaps.size(); ++i) {
    grc::rs2::TxMeta meta;
    meta.version = grc::rs2::ProtocolVersion::V16;
    meta.seq = snaps[i].seq;
    meta.frame = snaps[i].frame;
    grc::rs2::Transaction txn;
    if (i == 0) {
      txn = grc::rs2::make_full(snaps[i], meta);
      resolved = snaps[i];
    } else {
      meta.base_seq = snaps[i - 1].seq;
      txn = grc::rs2::make_patch(snaps[i - 1], snaps[i], meta);
      resolved = grc::rs2::resolve(resolved, txn);
    }
    // The resolved state encodes as the snapshot itself does.
    grc::rs2::TxMeta full_meta = meta;
    full_meta.base_seq = 0;
    const auto want = grc::rs2::encode_transaction(grc::rs2::make_full(snaps[i], full_meta));
    const auto got = grc::rs2::encode_transaction(grc::rs2::make_full(resolved, full_meta));
    check(want == got, "resolve(prev, patch) reproduces snapshot " + std::to_string(i + 1));
    records.push_back(grc::rs13::encode_transaction(txn, &predictor));
  }
  const std::string full_meta_text(records[2].begin(), records[2].end());
  check(full_meta_text.find("\"viewports\":[{\"id\":1,\"origin\":\"adopted\"") != std::string::npos,
        "the full carries the adopted viewport");
  const std::string patch4(records[5].begin(), records[5].end());
  check(patch4.find("\"removed_viewports\":[2]") != std::string::npos,
        "the patch that frees viewport 2 lists it in removed_viewports");
  records.push_back(grc::rs2::encode_end(make_end(1, snaps.size() - 1, records)));
  if (out_path != nullptr) {
    std::ofstream f(out_path, std::ios::binary);
    for (const auto &r : records) {
      f.write(reinterpret_cast<const char *>(r.data()), static_cast<std::streamsize>(r.size()));
    }
    check(f.good(), std::string("wrote ") + out_path);
  }
}

}  // namespace

int main() {
  const char *shadow = std::getenv("RS_MIRROR_TEST_SHADOW");
  if (shadow != nullptr && std::string(shadow) == "1") {
    Mirror::set_default_hc_shadow(true);
  }
  test_not_live_keeps_non_root_typing();
  test_create_fields_and_order();
  test_canvases_rows_and_unknown();
  test_3d_hdr_msaa();
  test_3d_adopted_late_equals_born();
  test_proxy_binding_and_node_route();
  test_node_route_uses_are_events();
  test_proxy_tombstones_and_replace();
  test_viewport_free();
  test_derived_unsupported_through_proxy();
  test_adoption();
  test_wire_roundtrip(std::getenv("RS_MIRROR_VP_OUT"));
  const std::uint64_t mismatches = Mirror::hc_shadow_mismatches_total();
  check(mismatches == 0, "the shadow oracle found no mismatch (" + std::to_string(mismatches) + ")");
  if (g_failures != 0) {
    std::fprintf(stderr, "rs_mirror_viewport_test: %d of %d checks failed\n", g_failures, g_checks);
    return 1;
  }
  std::printf("rs_mirror_viewport_test: all %d checks passed\n", g_checks);
  return 0;
}
