// The arm-time late-join adoption pass (gate8-design.md D3-D5, D13; G8w seam, G8a body).
//
// Under GRC_ADOPT=arm a capture that arms after the scene exists (a modder's runtime
// `GDExtensionManager.load_extension`, or any route whose main scene drew before the extension
// armed, Q1a) registers every canvas, canvas layer and canvas item reachable from the root window
// with origin `adopted`, so its first transaction equals what a capture armed at the scene's birth
// would have published (D15.1, modulo Q2's exception list). Two halves:
//
//   - the walk (adopt_at_arm): read-only ClassDB method binds over the node tree, in tree order
//     (internal children included), never a RenderingServer slot -- headless keeps the canvas
//     state but exposes no getters for it (D3). It fills an AdoptPlan.
//   - the application (apply_adopt_plan): engine-free. It drives the mirror through the same
//     setters the hooks call (Mirror::adopt_canvas / adopt_item, then set_parent, set_transform
//     ...), each only where the hooks would have been called, so "adoption declares exactly what
//     the hooks would have declared" (D5's rule) holds by construction, and the unit test
//     (test/rs_adopt_test.cpp) drives it with no engine.
//
// After the application the walk asks the engine for exactly the two things a running game asks
// for constantly (D3): `queue_redraw()` on every adopted item (the next MessageQueue flush re-sends
// `clear`, every command and a Control's transform, custom rect and clip through the hooks,
// before the frame callback publishes, D4) and the top-level re-raise `_top_level_raise_self`,
// called synchronously on every member of each canvas group in tree order (G8a "As built": the
// same calls, in the same order, that the deferred `SceneTree.call_group_flags` D3 names would
// make at the flush, without building Variant arguments for a vararg bind).
//
// Not adopted, by design (each stays typed by the mirror exactly as an unknown RID is today):
// RS-only items and canvases with no node (the residue: TileMapLayer quadrants, a script's
// `RenderingServer.canvas_item_create`, an embedded subwindow's canvas), and every subtree of a
// non-root viewport. Pre-arm textures, meshes and glyph atlases are G8r's, materials and shaders
// G8m's: a redrawn command naming one is the hooks' `unknown-texture` / `unknown-mesh`, an
// adopted material the hooks' `unknown-material`.
#ifndef GRC_RS_ADOPT_H
#define GRC_RS_ADOPT_H

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs {

class Mirror;

// What the adoption walk found and did, for `result.json` (gate8-design.md Q2 "adopt-account").
struct AdoptStats {
  bool ran = false;
  std::string error;            // empty, or why the walk adopted nothing (a missing object)
  std::uint32_t canvases = 0;   // canvases adopted (one per adopted CanvasLayer)
  std::uint32_t layers = 0;     // CanvasLayer nodes adopted
  std::uint32_t items = 0;      // CanvasItem nodes adopted
  std::uint32_t residue = 0;    // RS-only canvas/item RIDs named after arm (filled at result time)
  std::uint32_t hidden = 0;     // adopted items not visible in tree at arm (no commands until shown)
  std::uint32_t top_level = 0;  // canvas-group members re-raised (_top_level_raise_self)
  std::uint32_t redraws = 0;    // queue_redraw requests made
  std::uint32_t canvas_modulates = 0;  // canvases given a CanvasModulate colour
  std::uint32_t lights = 0;             // Light2D nodes declared (canvas-light, sticky)
  std::uint32_t non_root_viewports = 0; // viewport subtrees not walked (non-root-viewport)
  std::uint32_t materials = 0;          // adopted items with a material (unknown-material: G8m)
  std::uint64_t walk_ns = 0;   // the read-only tree walk
  std::uint64_t apply_ns = 0;  // the mirror application
  std::uint64_t engine_ns = 0; // the redraw requests and the re-raises
  std::uint64_t total_ns = 0;
};

// The sabotages that act on the walk (gate8-design.md Q2 "Sabotages").
enum class AdoptSabotage : std::uint8_t {
  None,
  SkipState,   // adopt-skip-state: structure without transforms, modulate or self-modulate
  NoRedraw,    // adopt-no-redraw: no queue_redraw (commands never re-sent)
  SkipLayers,  // adopt-skip-layers: CanvasLayer canvases left unknown
};

struct AdoptConfig {
  // The capture host's frame counter at arm, dated into the session's `adoption.frame` (>= 1).
  // Since G8a it is the main-loop iteration the walk runs in (entry.cpp aligns the capture's
  // frame counter with Engine.get_process_frames() under GRC_ADOPT=arm).
  std::uint64_t arm_frame = 1;
  AdoptSabotage sabotage = AdoptSabotage::None;
};

// One adopted CanvasLayer (D5 "Per layer"), in tree order.
struct AdoptedLayer {
  std::uint64_t canvas = 0;    // CanvasLayer.get_canvas()
  std::uint64_t viewport = 0;  // the viewport it attaches to (custom viewport, else its own)
  rs2::Xform xform = rs2::kIdentityXform;  // CanvasLayer.get_transform()
  std::int32_t layer = 1;      // CanvasLayer.get_layer()
  std::int32_t index = 0;      // Node.get_index(): the stacking sublayer (canvas_layer.cpp:206)
  bool follow_viewport = false;
  float follow_scale = 1.0f;
  std::uint64_t follow_parent = 0;  // the world canvas a following layer parents to
};

// One adopted CanvasItem (D5 "Per item"), in tree order (parents before children).
struct AdoptedItem {
  std::uint64_t rid = 0;     // CanvasItem.get_canvas_item()
  std::uint64_t parent = 0;  // the parent item's RID, or get_canvas() for a canvas-group member
  bool group_member = false; // no parent item: top level, or under a non-CanvasItem / layer
  std::int32_t child_index = 0;  // Node.get_index(true): the draw index of a child item
  rs2::Xform xform = rs2::kIdentityXform;
  rs2::Color4 modulate = rs2::kWhite;
  rs2::Color4 self_modulate = rs2::kWhite;
  bool visible = true;       // is_visible_in_tree(): the RS flag a hooked capture holds
  std::int32_t z_index = 0;
  bool z_relative = true;
  bool behind = false;
  std::uint32_t visibility_layer = 1;
  std::int32_t texture_filter = 0;  // resolved through the parent chain (the node's cache)
  std::int32_t texture_repeat = 0;
  std::uint64_t material = 0;       // get_material()->get_rid(), 0 when none
  bool use_parent_material = false;
  // Node-specific RS state the hooks type (D5's rule), declared as the node would have.
  bool light = false;               // a Light2D: canvas_light_attach_to_canvas(get_canvas())
  std::uint64_t light_canvas = 0;
  bool mirroring = false;           // a ParallaxLayer with non-zero mirroring
  float mirroring_xy[2] = {0.0f, 0.0f};
  bool repeat = false;              // a Parallax2D with a non-zero repeat size
  float repeat_xy[2] = {0.0f, 0.0f};
  std::int32_t repeat_times = 1;
};

struct AdoptPlan {
  std::vector<AdoptedLayer> layers;
  std::vector<AdoptedItem> items;
  // The active CanvasModulate colour per canvas (the first visible-in-tree one in tree order).
  std::vector<std::pair<std::uint64_t, rs2::Color4>> canvas_modulates;
  std::uint32_t non_root_viewports = 0;
};

// Drives `mirror` through the hooks' own setters for every object in `plan` (engine-free). Fills
// the canvas/layer/item/hidden/... counts of `stats`.
void apply_adopt_plan(Mirror &mirror, const AdoptPlan &plan, AdoptSabotage sabotage,
                      std::uint64_t frame, AdoptStats *stats);

// True when every method bind the walk needs resolves at its 4.5.1 hash; otherwise names the
// first missing one in `missing` (the stream refuses `adopt-unavailable`).
bool adopt_binds_ready(std::string *missing);

// True when the caller is the engine's main thread (OS.get_thread_caller_id() ==
// OS.get_main_thread_id()); otherwise describes both ids (the stream refuses `adopt-thread`, D4).
bool adopt_on_main_thread(std::string *detail);

// The engine's main-loop iteration counter now (Engine.get_process_frames(); it advances after
// the frame callback, main.cpp:4852, so it is the 0-based index of the iteration running), or -1.
std::int64_t adopt_engine_process_frames();

// Called once at arm on the main thread, when GRC_ADOPT=arm, after the root query and before the
// size policy (D4): walk, apply to the process-wide mirror, request the redraws and re-raises.
AdoptStats adopt_at_arm(const AdoptConfig &config);

// The adopted item RID -> node ObjectID map the walk built (D11's node map; G8m keeps it current).
const std::unordered_map<std::uint64_t, std::uint64_t> &adopted_item_nodes();

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_ADOPT_H
