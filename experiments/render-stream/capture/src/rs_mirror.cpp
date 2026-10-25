#include "rs_mirror.h"

#include "rs_texture_delivery.h"
#include "rs_texture_worker.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <iterator>
#include <map>
#include <set>
#include <cstring>
#include <memory>
#include <utility>

#include "rs_sha256.h"
#include "rs_shader_payload.h"
#include "rs_texture_payload.h"

namespace grc {
namespace rs {

using namespace rs2;  // NOLINT: the wire types are the mirror's own types

namespace {

std::string u64(std::uint64_t value) { return std::to_string(value); }

void log_line(const std::string &text) {
  std::fprintf(stdout, "[grc] stream: %s\n", text.c_str());
  std::fflush(stdout);
}

void erase_id(std::vector<std::uint32_t> *list, std::uint32_t id) {
  const auto it = std::find(list->begin(), list->end(), id);
  if (it != list->end()) {
    list->erase(it);
  }
}

}  // namespace

Mirror::Mirror() { reset(); }

void Mirror::reset() {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  drop_frame_ = 0;
  omit_op_.clear();
  omit_from_frame_ = 0;
  perturb_glyph_frame_ = 0;
  perturb_vertex_frame_ = 0;
  degenerate_host_size_ = false;
  global_reference_ = kIdentityXform;
  global_current_ = kIdentityXform;
  snap_transforms_ = false;
  snap_vertices_ = false;
  canvas_texture_headless_ = false;
  canvas_texture_created_ = false;
  unknown_policy_ = UnknownItemPolicy::Strict;
  max_items_ = kMaxLiveItems;
  max_commands_ = kMaxCommandsPerItem;
  unknown_rids_.clear();
  next_canvas_id_ = kRootCanvasId + 1;
  next_item_id_ = 1;
  root_viewport_rid_ = 0;
  canvases_.clear();
  items_.clear();
  canvas_by_rid_.clear();
  item_by_rid_.clear();
  untracked_items_.clear();
  textures_.clear();
  texture_by_rid_.clear();
  next_texture_id_ = 1;
  meshes_.clear();
  mesh_by_rid_.clear();
  next_mesh_id_ = 1;
  shaders_.clear();
  shader_by_rid_.clear();
  next_shader_id_ = 1;
  materials_.clear();
  material_by_rid_.clear();
  next_material_id_ = 1;
  shader_policy_ = ShaderPolicy::Source;
  perturb_shader_frame_ = 0;
  default_filter_ = Filter::Linear;
  default_repeat_ = Repeat::Disabled;
  failures_.clear();
  session_unsupported_.clear();
  stats_ = MirrorStats();

  // Canvas 1 always exists, so every snapshot has its root canvas
  // (render-stream-0.md invariant `root-canvas`, unchanged at /1), even when the root query
  // failed and no RID is bound to it.
  Canvas root;
  root.state.id = kRootCanvasId;
  root.state.origin = Origin::RootQuery;
  root.state.role = CanvasRole::Root;
  root.state.attached = true;
  canvases_.emplace(kRootCanvasId, std::move(root));
}

void Mirror::set_root(std::uint64_t viewport_rid, std::uint64_t canvas_rid,
                      const Xform &canvas_xform) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  Canvas &root = canvases_.at(kRootCanvasId);
  if (root.rid != 0) {
    canvas_by_rid_.erase(root.rid);
  }
  root_viewport_rid_ = viewport_rid;
  root.rid = canvas_rid;
  root.state.xform = canvas_xform;
  if (canvas_rid != 0) {
    canvas_by_rid_[canvas_rid] = kRootCanvasId;
  }
}

void Mirror::fail_root_query(const std::string &detail) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  fail(FailureReason::RootQueryFailed, detail);
}

void Mirror::fail_root_size_enforce(const std::string &detail) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  fail(FailureReason::RootSizeEnforceFailed, detail);
}

void Mirror::set_degenerate_host_size(bool on) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  degenerate_host_size_ = on;
}

void Mirror::set_canvas_texture_headless(bool on) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  canvas_texture_headless_ = on;
}

void Mirror::set_unknown_item_policy(UnknownItemPolicy policy) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  unknown_policy_ = policy;
}

void Mirror::set_drop_frame(std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  drop_frame_ = frame;
}

void Mirror::set_omit_op(const std::string &op, std::uint64_t from_frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  omit_op_ = op;
  omit_from_frame_ = from_frame;
}

void Mirror::set_perturb_glyph(std::uint64_t from_frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  perturb_glyph_frame_ = from_frame;
}

void Mirror::set_perturb_vertex(std::uint64_t from_frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  perturb_vertex_frame_ = from_frame;
}

std::uint64_t Mirror::epoch() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return epoch_;
}

// --- helpers (mutex_ held) ----------------------------------------------------

bool Mirror::omit_op_matches(const char *op, std::uint64_t frame) const {
  return !omit_op_.empty() && frame >= omit_from_frame_ && omit_op_ == op;
}

bool Mirror::dropped_identity(const char *op, std::uint64_t frame) {
  if (omit_op_matches(op, frame)) {
    ++stats_.dropped_omit_op;
    return true;
  }
  ++epoch_;
  return false;
}

bool Mirror::dropped(const char *op, std::uint64_t frame) {
  if (omit_op_matches(op, frame)) {
    ++stats_.dropped_omit_op;
    return true;
  }
  if (drop_frame_ != 0 && frame == drop_frame_) {
    ++stats_.dropped_omit_update;
    return true;
  }
  ++epoch_;
  return false;
}

Mirror::Item *Mirror::find_item(std::uint64_t rid) {
  const auto it = item_by_rid_.find(rid);
  if (it == item_by_rid_.end()) {
    return nullptr;
  }
  return &items_.at(it->second);
}

bool Mirror::find_target(std::uint64_t rid, Target *out) const {
  if (rid == 0) {
    return false;
  }
  const auto item = item_by_rid_.find(rid);
  if (item != item_by_rid_.end()) {
    *out = {Kind::Item, item->second};
    return true;
  }
  const auto canvas = canvas_by_rid_.find(rid);
  if (canvas != canvas_by_rid_.end()) {
    *out = {Kind::Canvas, canvas->second};
    return true;
  }
  return false;
}

Mirror::Item *Mirror::item_for(std::uint64_t rid, const char *op, std::uint64_t frame) {
  Item *item = find_item(rid);
  if (item != nullptr) {
    return item;
  }
  if (untracked_items_.count(rid) != 0) {
    // Not tracked because the live-item cap was hit; that is already a
    // mirror-capacity failure, not a second, misleading pre-existing one.
    ++stats_.ignored_untracked;
    return nullptr;
  }
  unknown(rid, op, frame);
  return nullptr;
}

void Mirror::unknown(std::uint64_t rid, const char *op, std::uint64_t frame) {
  if (skip_unknown()) {
    // protocol/unknown-item-skip.md: not a failure. The call is counted and not applied; the RID
    // stays unknown until it is freed. Only the first one is logged (a late-joined game names
    // thousands).
    ++stats_.unknown_calls;
    if (rid != 0 && unknown_rids_.insert(rid).second) {
      ++stats_.unknown_rids_named;
      if (stats_.unknown_rids_named == 1) {
        log_line("unknown (skipped) rid=" + u64(rid) + " op=" + op + " frame=" + u64(frame));
      }
    }
    return;
  }
  for (const Failure &failure : failures_) {
    if (failure.reason == FailureReason::PreExistingObject) {
      return;  // first event only; the failure is sticky
    }
  }
  const std::string detail = "rid=" + u64(rid) + " op=" + op + " frame=" + u64(frame);
  log_line("unknown " + detail);
  fail(FailureReason::PreExistingObject, detail);
}

void Mirror::fail(FailureReason reason, const std::string &detail) {
  for (const Failure &failure : failures_) {
    if (failure.reason == reason) {
      return;
    }
  }
  failures_.push_back({reason, detail});
}

void Mirror::session_unsupported(const char *op, UnsupportedReason reason) {
  for (const UnsupportedRef &entry : session_unsupported_) {
    if (entry.reason == reason && entry.op == op) {
      return;
    }
  }
  UnsupportedRef entry;
  entry.op = op;
  entry.has_item = false;
  entry.reason = reason;
  session_unsupported_.push_back(std::move(entry));
}

std::vector<std::uint32_t> *Mirror::children_of(ParentKind kind, std::uint32_t id) {
  if (kind == ParentKind::Canvas) {
    const auto it = canvases_.find(id);
    return it != canvases_.end() ? &it->second.state.items : nullptr;
  }
  if (kind == ParentKind::Item) {
    const auto it = items_.find(id);
    return it != items_.end() ? &it->second.state.children : nullptr;
  }
  return nullptr;
}

void Mirror::detach(Item *item) {
  std::vector<std::uint32_t> *list = children_of(item->state.parent.kind, item->state.parent.id);
  if (list != nullptr) {
    erase_id(list, item->state.id);
  }
  item->state.parent = ParentRef();
  item->unknown_parent = 0;
}

// --- unknown RIDs under Skip (protocol/unknown-item-skip.md) ------------------------------------

bool Mirror::is_withheld(const Item &item) const {
  const Item *cur = &item;
  // Bounded: a parent cycle (which the server does not refuse) never reaches an unknown RID.
  for (std::size_t steps = 0; steps <= items_.size(); ++steps) {
    if (cur->unknown_parent != 0) {
      return true;
    }
    if (cur->state.parent.kind != ParentKind::Item) {
      return false;
    }
    const auto it = items_.find(cur->state.parent.id);
    if (it == items_.end()) {
      return false;
    }
    cur = &it->second;
  }
  return false;
}

std::set<std::uint32_t> Mirror::withheld_ids() const {
  std::set<std::uint32_t> out;
  if (!skip_unknown()) {
    return out;
  }
  // P3-CAP: is_withheld() is true only on a chain through an item with an unknown parent; with
  // none, nothing is withheld and the per-item parent walks are skipped.
  bool any_unknown_parent = false;
  for (const auto &entry : items_) {
    if (entry.second.unknown_parent != 0) {
      any_unknown_parent = true;
      break;
    }
  }
  if (!any_unknown_parent) {
    return out;
  }
  for (const auto &entry : items_) {
    if (is_withheld(entry.second)) {
      out.insert(entry.first);
    }
  }
  return out;
}

void Mirror::rekey_subtree(std::uint32_t root_id) {
  // Pre-order walk of the subtree (a visited set guards against parent cycles).
  std::vector<std::uint32_t> order;
  std::set<std::uint32_t> seen;
  std::vector<std::uint32_t> stack = {root_id};
  while (!stack.empty()) {
    const std::uint32_t id = stack.back();
    stack.pop_back();
    const auto it = items_.find(id);
    if (it == items_.end() || !seen.insert(id).second) {
      continue;
    }
    order.push_back(id);
    const std::vector<std::uint32_t> &children = it->second.state.children;
    for (auto child = children.rbegin(); child != children.rend(); ++child) {
      stack.push_back(*child);
    }
  }
  // Only an id a receiver has seen needs replacing; the others keep theirs.
  std::map<std::uint32_t, std::uint32_t> renamed;
  for (std::uint32_t id : order) {
    if (items_.at(id).published) {
      renamed[id] = next_item_id_++;
    }
  }
  if (renamed.empty()) {
    return;
  }
  const auto rename = [&renamed](std::uint32_t id) {
    const auto it = renamed.find(id);
    return it == renamed.end() ? id : it->second;
  };
  // The subtree root's own container lies outside the subtree.
  const Item &root = items_.at(root_id);
  if (renamed.count(root_id) != 0 &&
      !(root.state.parent.kind == ParentKind::Item && seen.count(root.state.parent.id) != 0)) {
    if (std::vector<std::uint32_t> *list = children_of(root.state.parent.kind, root.state.parent.id)) {
      std::replace(list->begin(), list->end(), root_id, renamed.at(root_id));
    }
  }
  std::vector<Item> staged;
  staged.reserve(order.size());
  for (std::uint32_t id : order) {
    const auto it = items_.find(id);
    Item item = std::move(it->second);
    items_.erase(it);
    item.state.id = rename(id);
    item.published = false;
    for (std::uint32_t &child : item.state.children) {
      child = rename(child);
    }
    if (item.state.parent.kind == ParentKind::Item) {
      item.state.parent.id = rename(item.state.parent.id);
    }
    item_by_rid_[item.rid] = item.state.id;
    staged.push_back(std::move(item));
  }
  for (Item &item : staged) {
    const std::uint32_t id = item.state.id;
    items_.emplace(id, std::move(item));
  }
  stats_.rekeyed_items += renamed.size();
}

bool Mirror::forget_unknown(std::uint64_t rid) {
  if (!skip_unknown() || unknown_rids_.erase(rid) == 0) {
    return false;
  }
  for (auto &entry : items_) {
    if (entry.second.unknown_parent == rid) {
      entry.second.unknown_parent = 0;  // orphaned: no parent, as renderer_canvas_cull.cpp does
    }
  }
  return true;
}

// --- identity -------------------------------------------------------------------

void Mirror::canvas_create(std::uint64_t rid, std::uint64_t frame) {
  create_canvas(rid, frame, Origin::Created);
}

void Mirror::canvas_item_create(std::uint64_t rid, std::uint64_t frame) {
  create_item(rid, frame, Origin::Created);
}

void Mirror::adopt_canvas(std::uint64_t rid, std::uint64_t frame) {
  create_canvas(rid, frame, Origin::Adopted);
}

void Mirror::adopt_item(std::uint64_t rid, std::uint64_t frame) {
  create_item(rid, frame, Origin::Adopted);
}

void Mirror::set_caps(std::size_t max_items, std::size_t max_commands) {
  std::lock_guard<std::mutex> lock(mutex_);
  max_items_ = max_items;
  max_commands_ = max_commands;
}

void Mirror::create_canvas(std::uint64_t rid, std::uint64_t frame, Origin origin) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || dropped_identity("canvas_create", frame)) {
    return;
  }
  if (canvases_.size() >= max_items_) {
    ++stats_.dropped_capacity;
    fail(FailureReason::MirrorCapacity,
         "live canvases > " + u64(max_items_) + " rid=" + u64(rid) + " frame=" + u64(frame));
    return;
  }
  forget_unknown(rid);  // Skip: a recycled RID value is a new object
  Canvas canvas;
  canvas.rid = rid;
  canvas.state.id = next_canvas_id_++;
  canvas.state.origin = origin;
  canvas.state.role = CanvasRole::None;
  canvas.state.attached = false;
  canvas_by_rid_[rid] = canvas.state.id;
  canvases_.emplace(canvas.state.id, std::move(canvas));
}

void Mirror::create_item(std::uint64_t rid, std::uint64_t frame, Origin origin) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || dropped_identity("canvas_item_create", frame)) {
    return;
  }
  if (items_.size() >= max_items_) {
    ++stats_.dropped_capacity;
    untracked_items_.insert(rid);
    fail(FailureReason::MirrorCapacity,
         "live items > " + u64(max_items_) + " rid=" + u64(rid) + " frame=" + u64(frame));
    return;
  }
  forget_unknown(rid);  // Skip: a recycled RID value is a new object
  Item item;
  item.rid = rid;
  item.state.id = next_item_id_++;
  item.state.origin = origin;
  item_by_rid_[rid] = item.state.id;
  items_.emplace(item.state.id, std::move(item));
}

void Mirror::free_rid(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (omit_op_matches("free", frame)) {
    // omit-op `free`: the item (or canvas) stays, with its parent link and
    // its place in its parent's list.
    ++stats_.dropped_omit_op;
    return;
  }
  if (Item *item = find_item(rid)) {
    ++epoch_;
    // renderer_canvas_cull.cpp:2585-2600: leave the parent, orphan the children.
    detach(item);
    for (std::uint32_t child : item->state.children) {
      const auto it = items_.find(child);
      if (it != items_.end()) {
        it->second.state.parent = ParentRef();
      }
    }
    const std::uint32_t id = item->state.id;
    item_by_rid_.erase(rid);
    items_.erase(id);
    return;
  }
  const auto canvas_it = canvas_by_rid_.find(rid);
  if (canvas_it != canvas_by_rid_.end()) {
    ++epoch_;
    // renderer_canvas_cull.cpp:2566: the canvas's child items lose their parent.
    Canvas &canvas = canvases_.at(canvas_it->second);
    for (std::uint32_t child : canvas.state.items) {
      const auto it = items_.find(child);
      if (it != items_.end()) {
        it->second.state.parent = ParentRef();
      }
    }
    canvas.state.items.clear();
    const std::uint32_t id = canvas.state.id;
    canvas_by_rid_.erase(canvas_it);
    if (id == kRootCanvasId) {
      // The root canvas stays in every snapshot (invariant `root-canvas`); it
      // only stops matching the freed RID.
      canvas.rid = 0;
    } else {
      canvases_.erase(id);
    }
    return;
  }
  if (forget_unknown(rid)) {
    // protocol/unknown-item-skip.md: a freed unknown RID is dropped silently; the known items
    // parented to it become orphans and are published again (under ids never shown before).
    ++epoch_;
    return;
  }
  if (untracked_items_.erase(rid) != 0) {
    ++epoch_;
    return;
  }
  const auto texture_it = texture_by_rid_.find(rid);
  if (texture_it != texture_by_rid_.end()) {
    // gate2-design.md Q3: a texture a command still names becomes a `freed`
    // tombstone (version unchanged, payload released); otherwise its id
    // leaves the table.
    ++epoch_;
    const std::uint32_t id = texture_it->second;
    retire_texture(id);
    return;
  }
  const auto mesh_it = mesh_by_rid_.find(rid);
  if (mesh_it != mesh_by_rid_.end()) {
    // G5e (gate5-design.md Q3b): a mesh an add_mesh still names becomes a `freed` tombstone
    // (version unchanged, payloads released); otherwise its id leaves the table.
    ++epoch_;
    const std::uint32_t id = mesh_it->second;
    retire_mesh(id);
    return;
  }
  const auto shader_it = shader_by_rid_.find(rid);
  if (shader_it != shader_by_rid_.end()) {
    // G55d (D5; g3ms.cpp:2184-2198): freeing a shader sets every material naming it to no shader
    // (version + 1); no tombstone.
    ++epoch_;
    const std::uint32_t id = shader_it->second;
    for (auto &entry : materials_) {
      Material &material = entry.second;
      if (material.has_shader && material.shader == id) {
        material.has_shader = false;
        material.shader = 0;
        ++material.version;
      }
    }
    shader_by_rid_.erase(shader_it);
    shaders_.erase(id);
    return;
  }
  const auto material_it = material_by_rid_.find(rid);
  if (material_it != material_by_rid_.end()) {
    // G55d (D5; g3ms.cpp:2394-2411, rcc:61-67): freeing a material resets every item naming it.
    ++epoch_;
    const std::uint32_t id = material_it->second;
    for (auto &entry : items_) {
      ItemState &state = entry.second.state;
      if (state.has_material && state.material == id) {
        state.has_material = false;
        state.material = 0;
      }
    }
    material_by_rid_.erase(material_it);
    materials_.erase(id);
    return;
  }
  ++stats_.free_unknown;  // anything else this mirror does not model
}

// --- viewport -------------------------------------------------------------------

void Mirror::viewport_attach_canvas(std::uint64_t viewport, std::uint64_t canvas,
                                    std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "viewport_attach_canvas";
  if (dropped(kOp, frame)) {
    return;
  }
  if (viewport != root_viewport_rid_ || root_viewport_rid_ == 0) {
    session_unsupported(kOp, UnsupportedReason::NonRootViewport);
    return;
  }
  const auto it = canvas_by_rid_.find(canvas);
  if (it == canvas_by_rid_.end()) {
    unknown(canvas, kOp, frame);
    return;
  }
  Canvas &target = canvases_.at(it->second);
  target.state.attached = true;
  // render-stream-6.md "Canvas": viewport_attach_canvas resets the stacking to (0,0)
  // (rv.cpp:1265-1266). Since G6b a canvas attached to the root viewport is supported: no
  // extra-canvas entry (gate6-design.md D3, Q3b).
  target.state.layer = 0;
  target.state.sublayer = 0;
}

void Mirror::viewport_remove_canvas(std::uint64_t viewport, std::uint64_t canvas,
                                    std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "viewport_remove_canvas";
  if (dropped(kOp, frame)) {
    return;
  }
  if (viewport != root_viewport_rid_ || root_viewport_rid_ == 0) {
    session_unsupported(kOp, UnsupportedReason::NonRootViewport);
    return;
  }
  const auto it = canvas_by_rid_.find(canvas);
  if (it == canvas_by_rid_.end()) {
    unknown(canvas, kOp, frame);
    return;
  }
  // Q3b: its items stay in the table (undrawn), as gate 0 keeps a detached canvas.
  canvases_.at(it->second).state.attached = false;
}

void Mirror::viewport_set_canvas_stacking(std::uint64_t viewport, std::uint64_t canvas,
                                          std::int32_t layer, std::int32_t sublayer,
                                          std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "viewport_set_canvas_stacking";
  if (dropped(kOp, frame)) {
    return;
  }
  if (viewport != root_viewport_rid_ || root_viewport_rid_ == 0) {
    session_unsupported(kOp, UnsupportedReason::NonRootViewport);
    return;
  }
  const auto it = canvas_by_rid_.find(canvas);
  if (it == canvas_by_rid_.end()) {
    unknown(canvas, kOp, frame);
    return;
  }
  Canvas &target = canvases_.at(it->second);
  target.state.layer = layer;
  target.state.sublayer = sublayer;
}

void Mirror::viewport_set_global_canvas_transform(std::uint64_t viewport, const Xform &xform,
                                                  std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "viewport_set_global_canvas_transform";
  if (dropped(kOp, frame)) {
    return;
  }
  if (viewport != root_viewport_rid_ || root_viewport_rid_ == 0) {
    session_unsupported(kOp, UnsupportedReason::NonRootViewport);
    return;
  }
  global_current_ = xform;
}

void Mirror::canvas_set_item_mirroring(std::uint64_t canvas, std::uint64_t item, float x,
                                       float y, std::uint64_t frame) {
  (void)canvas;
  (void)item;
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_set_item_mirroring";
  if (dropped(kOp, frame)) {
    return;
  }
  if (x != 0.0f || y != 0.0f) {
    session_unsupported(kOp, UnsupportedReason::CanvasRepeat);  // sticky (Q3b)
  }
}

void Mirror::canvas_set_item_repeat(std::uint64_t item, float x, float y, std::int32_t times,
                                    std::uint64_t frame) {
  (void)item;
  (void)times;
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_set_item_repeat";
  if (dropped(kOp, frame)) {
    return;
  }
  if (x != 0.0f || y != 0.0f) {
    session_unsupported(kOp, UnsupportedReason::CanvasRepeat);  // sticky (Q3b)
  }
}

void Mirror::canvas_set_parent(std::uint64_t canvas, std::uint64_t parent, std::uint64_t frame) {
  (void)canvas;
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_set_parent";
  if (dropped(kOp, frame)) {
    return;
  }
  if (parent != 0) {
    session_unsupported(kOp, UnsupportedReason::CanvasFollowViewport);  // sticky (Q3b)
  }
}

void Mirror::set_global_canvas_reference(const Xform &xform) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  global_reference_ = xform;
  global_current_ = xform;
}

void Mirror::set_snap_2d(bool transforms, bool vertices) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  snap_transforms_ = transforms;
  snap_vertices_ = vertices;
}

void Mirror::viewport_set_canvas_transform(std::uint64_t viewport, std::uint64_t canvas,
                                           const Xform &xform, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "viewport_set_canvas_transform";
  if (dropped(kOp, frame)) {
    return;
  }
  if (viewport != root_viewport_rid_ || root_viewport_rid_ == 0) {
    session_unsupported(kOp, UnsupportedReason::NonRootViewport);
    return;
  }
  const auto it = canvas_by_rid_.find(canvas);
  if (it == canvas_by_rid_.end()) {
    unknown(canvas, kOp, frame);
    return;
  }
  canvases_.at(it->second).state.xform = xform;
}

// --- canvas items -----------------------------------------------------------------

void Mirror::set_parent(std::uint64_t item_rid, std::uint64_t parent_rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_set_parent";
  if (dropped(kOp, frame)) {
    return;
  }
  Item *item = item_for(item_rid, kOp, frame);
  if (item == nullptr) {
    return;
  }
  const bool was_withheld = skip_unknown() && is_withheld(*item);
  ParentRef parent;
  std::uint64_t unknown_parent = 0;
  if (parent_rid != 0) {
    Target target;
    if (!find_target(parent_rid, &target)) {
      if (untracked_items_.count(parent_rid) != 0) {
        ++stats_.ignored_untracked;
        return;
      }
      unknown(parent_rid, kOp, frame);
      if (!skip_unknown()) {
        return;
      }
      // protocol/unknown-item-skip.md: the link is kept, so the item (and its subtree) is
      // withheld until it is reparented to something known or the unknown RID is freed.
      unknown_parent = parent_rid;
    } else {
      parent.kind = target.kind == Kind::Canvas ? ParentKind::Canvas : ParentKind::Item;
      parent.id = target.id;
    }
  }
  // renderer_canvas_cull.cpp:569-598: remove from the old parent's list, then
  // append to the new one -- even when the parent is unchanged.
  detach(item);
  if (unknown_parent != 0) {
    item->unknown_parent = unknown_parent;
  } else if (parent.kind != ParentKind::None) {
    std::vector<std::uint32_t> *list = children_of(parent.kind, parent.id);
    if (list != nullptr) {
      list->push_back(item->state.id);
      item->state.parent = parent;
    }
  }
  if (skip_unknown() && !was_withheld && is_withheld(*item)) {
    rekey_subtree(item->state.id);  // invalidates `item`
  }
}

void Mirror::set_transform(std::uint64_t rid, const Xform &xform, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_transform", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_transform", frame)) {
    item->state.xform = xform;
  }
}

void Mirror::set_modulate(std::uint64_t rid, const Color4 &color, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_modulate", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_modulate", frame)) {
    item->state.modulate = color;
  }
}

void Mirror::set_self_modulate(std::uint64_t rid, const Color4 &color, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_self_modulate", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_self_modulate", frame)) {
    item->state.self_modulate = color;
  }
}

void Mirror::set_visible(std::uint64_t rid, bool visible, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_visible", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_visible", frame)) {
    item->state.visible = visible;
  }
}

void Mirror::set_clip(std::uint64_t rid, bool clip, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_clip", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_clip", frame)) {
    item->state.clip = clip;
  }
}

void Mirror::set_custom_rect(std::uint64_t rid, bool enabled, const Rect4 &rect,
                             std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_custom_rect", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_custom_rect", frame)) {
    item->state.custom_rect = enabled;
    item->state.custom_rect_rect = rect;
  }
}

void Mirror::set_visibility_layer(std::uint64_t rid, std::uint32_t layer, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_visibility_layer", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_visibility_layer", frame)) {
    item->state.visibility_layer = layer;
  }
}

void Mirror::set_z_index(std::uint64_t rid, std::int32_t z, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_z_index", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_z_index", frame)) {
    item->state.z_index = z;
  }
}

void Mirror::set_draw_index(std::uint64_t rid, std::int32_t index, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_draw_index", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_draw_index", frame)) {
    item->state.draw_index = index;
  }
}

void Mirror::set_z_relative(std::uint64_t rid, bool relative, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_z_as_relative_to_parent", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_z_as_relative_to_parent", frame)) {
    item->state.z_relative = relative;
  }
}

void Mirror::set_behind(std::uint64_t rid, bool behind, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_draw_behind_parent", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_draw_behind_parent", frame)) {
    item->state.behind = behind;
  }
}

void Mirror::attach_skeleton(std::uint64_t rid, std::uint64_t skeleton, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_attach_skeleton", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_attach_skeleton", frame)) {
    item->unsupported_skeleton = skeleton != 0;
  }
}

void Mirror::clear(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_clear", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_clear", frame)) {
    // Gate 3 (gate3-design.md D3, Q1b): the engine's Item::clear() also resets the clip flag
    // (servers/rendering/renderer_canvas_render.h:455) but keeps custom_rect, so a Control's net
    // clip after a redraw is the set_clip that follows the clear, and a raw item that clears
    // without re-asserting it stops clipping.
    item->state.commands.clear();
    item->state.clip = false;
    ++item->state.content_version;
  }
}

void Mirror::add_rect(std::uint64_t rid, const Rect4 &rect, const Color4 &color, bool antialiased,
                      std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_add_rect", frame)) {
    return;
  }
  Item *item = item_for(rid, "canvas_item_add_rect", frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  command.kind = CommandKind::AddRect;
  command.antialiased = antialiased;
  command.rect = rect;
  command.color = color;
  push_command(item, std::move(command), frame);
}

void Mirror::add_unsupported(std::uint64_t rid, const char *op, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(op, frame)) {
    return;
  }
  Item *item = item_for(rid, op, frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  command.kind = CommandKind::Unsupported;
  command.name = op;
  command.unsupported_reason = UnsupportedCmdReason::UnsupportedOp;
  push_command(item, std::move(command), frame);
}

void Mirror::push_command(Item *item, Command command, std::uint64_t frame) {
  if (item->state.commands.size() >= max_commands_) {
    ++stats_.dropped_capacity;
    fail(FailureReason::MirrorCapacity, "commands > " + u64(max_commands_) +
                                            " item=" + u64(item->state.id) + " frame=" + u64(frame));
    return;
  }
  item->state.commands.push_back(std::move(command));
  ++item->state.content_version;
}

// --- textures (G2b2) ----------------------------------------------------------------

namespace {

// A command that names a texture-table entry through `tex` (render-stream-2.md "Commands";
// render-stream-3.md "Command" adds the msdf region; render-stream-4.md "Command" the /4 ops
// that carry `tex`, add_mesh included since G5e).
bool names_texture(const Command &command) {
  switch (command.kind) {
    case CommandKind::AddTextureRect:
    case CommandKind::AddTextureRectRegion:
    case CommandKind::AddMsdfTextureRectRegion:
    case CommandKind::AddPrimitive:
    case CommandKind::AddPolygon:
    case CommandKind::AddTriangleArray:
    case CommandKind::AddNinePatch:
    case CommandKind::AddMesh:
      return true;
    default:
      return false;
  }
}

// The RenderingServer method a supported command came from (the item-level entry's `op`).
const char *rs_method_name(CommandKind kind) {
  switch (kind) {
    case CommandKind::AddRect: return "canvas_item_add_rect";
    case CommandKind::AddTextureRect: return "canvas_item_add_texture_rect";
    case CommandKind::AddTextureRectRegion: return "canvas_item_add_texture_rect_region";
    case CommandKind::AddMsdfTextureRectRegion: return "canvas_item_add_msdf_texture_rect_region";
    case CommandKind::AddLine: return "canvas_item_add_line";
    case CommandKind::AddPolyline: return "canvas_item_add_polyline";
    case CommandKind::AddMultiline: return "canvas_item_add_multiline";
    case CommandKind::AddCircle: return "canvas_item_add_circle";
    case CommandKind::AddPrimitive: return "canvas_item_add_primitive";
    case CommandKind::AddPolygon: return "canvas_item_add_polygon";
    case CommandKind::AddTriangleArray: return "canvas_item_add_triangle_array";
    case CommandKind::AddNinePatch: return "canvas_item_add_nine_patch";
    case CommandKind::AddMesh: return "canvas_item_add_mesh";
    case CommandKind::AddSetTransform: return "canvas_item_add_set_transform";
    case CommandKind::AddClipIgnore: return "canvas_item_add_clip_ignore";
    case CommandKind::Unsupported: break;
  }
  return "";
}

bool reason_from_text(const std::string &text, TextureReason *out) {
  static const std::pair<const char *, TextureReason> kReasons[] = {
      {"unsupported-format", TextureReason::UnsupportedFormat},
      {"payload-too-large", TextureReason::PayloadTooLarge},
      {"payload-unavailable", TextureReason::PayloadUnavailable},
      {"update-shape-mismatch", TextureReason::UpdateShapeMismatch},
      {"layered-update", TextureReason::LayeredUpdate},
      {"unknown-texture", TextureReason::UnknownTexture},
      {"canvas-texture-channel", TextureReason::CanvasTextureChannel},
  };
  for (const auto &entry : kReasons) {
    if (text == entry.first) {
      *out = entry.second;
      return true;
    }
  }
  return false;
}

// The hook log's shape rule (rs_resource_log.cpp same_shape), so both registries accept and
// refuse the same updates.
bool same_shape(const PayloadCopy &a, const PayloadCopy &b) {
  return a.format == b.format && a.width == b.width && a.height == b.height &&
         a.mipmaps_known == b.mipmaps_known && a.mipmaps == b.mipmaps && a.format >= 0 &&
         a.width >= 0 && a.height >= 0;
}

// The status and payload a copy gives an image texture.
void take_copy(const PayloadCopy &copy, PayloadPtr bytes, TextureStatus *status, bool *has_reason,
               TextureReason *reason, PayloadPtr *held, bool pending = false) {
  if (copy.status == "ok" && (bytes != nullptr || pending)) {
    *status = TextureStatus::Ok;
    *has_reason = false;
    *held = std::move(bytes);
    return;
  }
  *status = TextureStatus::Unsupported;
  *has_reason = true;
  if (!reason_from_text(copy.reason, reason)) {
    *reason = TextureReason::PayloadUnavailable;
  }
  held->reset();
}

}  // namespace

bool Mirror::omits(const char *op, std::uint64_t frame) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return omit_op_matches(op, frame);
}

Mirror::Texture *Mirror::find_texture(std::uint64_t rid) {
  const auto it = texture_by_rid_.find(rid);
  return it == texture_by_rid_.end() ? nullptr : &textures_.at(it->second);
}

bool Mirror::texture_ref(std::uint64_t rid, bool *has_tex, std::uint32_t *tex) const {
  if (rid == 0) {
    *has_tex = false;
    *tex = 0;
    return true;
  }
  const auto it = texture_by_rid_.find(rid);
  if (it == texture_by_rid_.end()) {
    return false;
  }
  *has_tex = true;
  *tex = it->second;
  return true;
}

bool Mirror::texture_referenced(std::uint32_t id) const {
  for (const auto &entry : items_) {
    for (const Command &command : entry.second.state.commands) {
      if (names_texture(command) && command.has_tex && command.tex == id) {
        return true;
      }
    }
  }
  // G55d: a material's rid parameter, an item's rid instance parameter and a shader's default
  // texture also keep it (each names it by id on the wire).
  for (const auto &entry : materials_) {
    for (const auto &param : entry.second.params) {
      if (param.second.ok && param.second.param.has_tex && param.second.param.tex == id) {
        return true;
      }
    }
  }
  for (const auto &entry : items_) {
    for (const auto &param : entry.second.instance_params) {
      if (param.second.has_tex && param.second.tex == id) {
        return true;
      }
    }
  }
  for (const auto &entry : shaders_) {
    for (const auto &ref : entry.second.default_textures) {
      if (ref.second == id) {
        return true;
      }
    }
  }
  // G2d: a canvas texture's diffuse channel also keeps its target alive (a
  // freed image a CanvasTexture still names becomes a tombstone too).
  for (const auto &entry : textures_) {
    const Texture &texture = entry.second;
    if (texture.kind == TextureKind::Canvas && texture.has_diffuse &&
        texture.diffuse_id == id) {
      return true;
    }
  }
  return false;
}

void Mirror::retire_texture(std::uint32_t id) {
  const auto it = textures_.find(id);
  if (it == textures_.end()) {
    return;
  }
  Texture &texture = it->second;
  if (texture.rid != 0) {
    texture_by_rid_.erase(texture.rid);
    texture.rid = 0;
  }
  if (!texture_referenced(id)) {
    textures_.erase(it);
    return;
  }
  // D11: a tombstone keeps its id and version; a receiver draws its commands with RID().
  texture.status = TextureStatus::Freed;
  texture.has_reason = false;
  texture.bytes.reset();
  texture.job.reset();
  reset_basis(&texture);
}

void Mirror::reset_basis(Texture *texture) {
  texture->basis.reset();
  texture->uastc_hash.clear();
  texture->uastc_params.clear();
  texture->uastc_bytes.reset();
  texture->basis_decided = false;
}

void Mirror::set_basis_submit(BasisSubmit submit) {
  std::lock_guard<std::mutex> lock(mutex_);
  basis_submit_ = std::move(submit);
}

std::vector<BasisJobPtr> Mirror::basis_jobs() const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<BasisJobPtr> out;
  for (const auto &entry : textures_) {
    if (entry.second.basis != nullptr && !entry.second.basis->done()) {
      out.push_back(entry.second.basis);
    }
  }
  return out;
}

std::size_t Mirror::service_basis(bool attach, bool wait) {
  std::unique_lock<std::mutex> lock(mutex_);
  if (!basis_submit_) {
    return 0;
  }
  const BasisConfig config = texture_delivery_basis_config();
  if (wait) {
    // G8kf: the test knob's frame first waits for the texture workers too, so every image has its
    // hash (and its encode queued) whatever the machine's speed.
    for (auto &entry : textures_) {
      if (entry.second.job != nullptr) {
        entry.second.job->wait();
      }
    }
  }
  // 1. Start: every settled ok image whose current content has no Basis outcome yet (D12).
  for (auto &entry : textures_) {
    Texture &texture = entry.second;
    settle(&texture);
    if (resolve_pending(&texture)) {
      ++epoch_;  // G8kf: the encode below is of the version the receivers will see
    }
    if (texture.kind != TextureKind::Image || texture.status != TextureStatus::Ok ||
        texture.basis_decided || texture.basis != nullptr || texture.bytes == nullptr ||
        texture.job != nullptr) {
      continue;
    }
    const char *format = image_format_name(texture.copy.format);
    const std::string name = format != nullptr ? format : "";
    const bool mipmaps = texture.copy.mipmaps_known && texture.copy.mipmaps;
    const char *decline = basis_decline_reason(name, texture.copy.width, texture.copy.height,
                                               texture.updated, config.min_px);
    if (decline != nullptr) {
      texture.basis_decided = true;
      texture_delivery_note_basis_decline(decline);
      continue;
    }
    BasisJobPtr job = std::make_shared<BasisJob>(texture.id, texture.version, texture.copy.hash,
                                                 texture.bytes, name, texture.copy.width,
                                                 texture.copy.height, mipmaps,
                                                 texture.copy.source_key);
    if (!basis_submit_(job)) {
      continue;  // the pool is not running: try again at the next callback
    }
    texture_delivery_note_basis_submit();
    texture.basis = std::move(job);
  }
  // 2. Wait (outside the lock: hooks on other threads keep going; workers never take it).
  if (wait) {
    std::vector<BasisJobPtr> pending;
    for (const auto &entry : textures_) {
      if (entry.second.basis != nullptr) {
        pending.push_back(entry.second.basis);
      }
    }
    lock.unlock();
    for (const BasisJobPtr &job : pending) {
      job->wait();
    }
    lock.lock();
  }
  if (!attach) {
    return 0;
  }
  // 3. Attach: a finished encode of the content the entry still has (D6: equal version).
  std::size_t attached = 0;
  for (auto &entry : textures_) {
    Texture &texture = entry.second;
    if (texture.basis == nullptr || !texture.basis->done()) {
      continue;
    }
    const BasisJobPtr job = std::move(texture.basis);
    texture.basis.reset();
    const BasisJob::Outcome &outcome = job->outcome();
    if (outcome.error == "abandoned") {
      continue;
    }
    const bool current = texture.kind == TextureKind::Image &&
                         texture.status == TextureStatus::Ok &&
                         texture.version == job->version() &&
                         texture.copy.hash == job->source_hash();
    if (!current) {
      texture_delivery_note_basis_result(false, true, *job);
      continue;  // the content changed meanwhile; the change already reset basis_decided
    }
    texture.basis_decided = true;
    if (!outcome.ok || outcome.ktx2 == nullptr || outcome.hash == texture.copy.hash) {
      texture_delivery_note_basis_result(false, false, *job);
      continue;
    }
    texture.uastc_hash = outcome.hash;
    texture.uastc_params = outcome.params;
    texture.uastc_bytes = outcome.ktx2;
    texture_delivery_note_basis_result(true, false, *job);
    ++attached;
  }
  if (attached != 0) {
    ++epoch_;
  }
  return attached;
}

void Mirror::settle(Texture *texture) {
  // A mispredicted job stays pending, so the snapshot's resolve_captured() reports it.
  if (texture->job == nullptr || !texture->job->done() || texture->job->mispredict()) {
    return;
  }
  texture->job->fill(&texture->copy);
  texture->bytes = texture->job->bytes();
  texture->job.reset();
}

bool Mirror::resolve_pending(Texture *texture) {
  if (texture->pending_version == 0 || texture->job != nullptr) {
    return false;
  }
  const bool same = texture->pending_version == texture->version;
  texture->pending_version = 0;
  if (!same) {
    return false;  // the content changed meanwhile: the version already moved past the pending one
  }
  if (texture->kind == TextureKind::Image && texture->status == TextureStatus::Ok) {
    texture->version += 1;  // render-stream-9.md: the recovery from delivery-pending is a new version
    return true;
  }
  return false;
}

void Mirror::set_publish_pending(bool on) {
  std::lock_guard<std::mutex> lock(mutex_);
  publish_pending_ = on;
}

std::uint64_t Mirror::pending_published() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return pending_published_;
}

void Mirror::service_pending() {
  std::lock_guard<std::mutex> lock(mutex_);
  bool moved = false;
  for (auto &entry : textures_) {
    Texture &texture = entry.second;
    if (texture.pending_version == 0) {
      continue;
    }
    settle(&texture);
    moved = resolve_pending(&texture) || moved;
  }
  if (moved) {
    ++epoch_;
  }
}

TextureEntry Mirror::wire_entry(const Texture &texture) {
  TextureEntry out;
  out.id = texture.id;
  out.kind = texture.kind;
  out.status = texture.status;
  out.version = texture.version;
  out.origin = texture.origin;  // G8r
  out.adopted_content = texture.adopted_content;
  if (texture.kind == TextureKind::Canvas) {
    // render-stream-2.md "Texture" field table: a canvas entry carries no shape, but keeps its
    // {diffuse, filter, repeat} (and reason, if unsupported) while status isn't freed.
    if (texture.status != TextureStatus::Freed) {
      out.has_canvas = true;
      out.canvas.has_diffuse = texture.has_diffuse;
      out.canvas.diffuse = texture.diffuse_id;
      out.canvas.filter = texture.filter;
      out.canvas.repeat = texture.repeat;
      if (texture.status == TextureStatus::Unsupported) {
        out.has_reason = texture.has_reason;
        out.reason = texture.reason;
      }
    }
    return out;
  }
  if (texture.status == TextureStatus::Freed || texture.kind != TextureKind::Image) {
    // render-stream-2.md "Texture" field table: placeholders and tombstones carry no shape.
    return out;
  }
  const PayloadCopy &copy = texture.copy;
  const char *format = image_format_name(copy.format);
  out.has_format = format != nullptr;
  out.format = format != nullptr ? format : "";
  out.width = static_cast<std::int32_t>(std::max<std::int64_t>(copy.width, 0));
  out.height = static_cast<std::int32_t>(std::max<std::int64_t>(copy.height, 0));
  out.mipmaps = copy.mipmaps_known && copy.mipmaps;
  if (texture.status == TextureStatus::Ok) {
    out.has_hash = true;
    out.hash = copy.hash;
    // G8t (render-stream-8.md "Resource tables"): a host decode names its source format; the
    // codec writes the key at /8 only, and D2 keeps a decode policy off every other version.
    const char *source = copy.source_format >= 0 ? image_format_name(copy.source_format) : nullptr;
    out.has_source_format = source != nullptr;
    out.source_format = source != nullptr ? source : "";
    out.payload_bytes = static_cast<std::uint64_t>(std::max<std::int64_t>(copy.payload_bytes, 0));
    // G8k9 (render-stream-9.md "Texture entries"): the delivery seam's variants, written at /9
    // only. The seam offers nothing yet, so every entry stays `decoded` alone.
    VariantRequest request;
    request.id = texture.id;
    request.hash = copy.hash;
    request.format = out.format;
    request.width = out.width;
    request.height = out.height;
    request.mipmaps = out.mipmaps;
    request.version = texture.version;
    // G8kp: the hooked block bytes, when the hook kept them (a /9 passthrough stream).
    request.block.hash = copy.block_hash;
    request.block.format = copy.block_format;
    request.block.payload_bytes =
        static_cast<std::uint64_t>(std::max<std::int64_t>(copy.block_payload_bytes, 0));
    // G8ku: the lazy uastc variant, once attached (service_basis).
    request.uastc_hash = texture.uastc_hash;
    request.uastc_params = texture.uastc_params;
    request.uastc_payload_bytes =
        texture.uastc_bytes != nullptr ? static_cast<std::uint64_t>(texture.uastc_bytes->size()) : 0;
    out.variants = texture_variants(request);
  } else {
    out.has_reason = texture.has_reason;
    out.reason = texture.reason;
  }
  return out;
}

void Mirror::add_texture_rect(std::uint64_t rid, const Rect4 &rect, std::uint64_t texture,
                              bool tile, const Color4 &modulate, bool transpose,
                              std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_add_texture_rect";
  if (dropped(kOp, frame)) {
    return;
  }
  Item *item = item_for(rid, kOp, frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  if (texture == 0 && canvas_texture_headless_) {
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = UnsupportedCmdReason::CanvasTextureHeadless;
  } else if (!texture_ref(texture, &command.has_tex, &command.tex)) {
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = UnsupportedCmdReason::UnknownTexture;
  } else {
    command.kind = CommandKind::AddTextureRect;
    command.tile = tile;
    command.transpose = transpose;
    command.rect = rect;
    command.modulate = modulate;
  }
  push_command(item, std::move(command), frame);
}

void Mirror::add_texture_rect_region(std::uint64_t rid, const Rect4 &rect, std::uint64_t texture,
                                     const Rect4 &src, const Color4 &modulate, bool transpose,
                                     bool clip_uv, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_add_texture_rect_region";
  if (dropped(kOp, frame)) {
    return;
  }
  Item *item = item_for(rid, kOp, frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  if (texture == 0 && canvas_texture_headless_) {
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = UnsupportedCmdReason::CanvasTextureHeadless;
  } else if (!texture_ref(texture, &command.has_tex, &command.tex)) {
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = UnsupportedCmdReason::UnknownTexture;
  } else {
    command.kind = CommandKind::AddTextureRectRegion;
    command.transpose = transpose;
    command.clip_uv = clip_uv;
    command.rect = perturbed_glyph(rect, frame);
    command.src = src;
    command.modulate = modulate;
  }
  push_command(item, std::move(command), frame);
}

void Mirror::add_msdf_texture_rect_region(std::uint64_t rid, const Rect4 &rect,
                                          std::uint64_t texture, const Rect4 &src,
                                          const Color4 &modulate, std::int32_t outline_size,
                                          float px_range, float scale, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_add_msdf_texture_rect_region";
  if (dropped(kOp, frame)) {
    return;
  }
  Item *item = item_for(rid, kOp, frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  if (texture == 0 && canvas_texture_headless_) {
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = UnsupportedCmdReason::CanvasTextureHeadless;
  } else if (!texture_ref(texture, &command.has_tex, &command.tex)) {
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = UnsupportedCmdReason::UnknownTexture;
  } else {
    command.kind = CommandKind::AddMsdfTextureRectRegion;
    command.rect = perturbed_glyph(rect, frame);
    command.src = src;
    command.modulate = modulate;
    command.msdf_outline = outline_size;
    command.msdf_px_range = px_range;
    command.msdf_scale = scale;
  }
  push_command(item, std::move(command), frame);
}

Rect4 Mirror::perturbed_glyph(const Rect4 &rect, std::uint64_t frame) const {
  Rect4 out = rect;
  if (perturb_glyph_frame_ != 0 && frame >= perturb_glyph_frame_) {
    out[0] += 0.25f;  // gate4-design.md Q3 "perturb-glyph": rect.x + 0.25, recorded only
  }
  return out;
}

// --- render-stream/4 immediate geometry (G5d) ----------------------------------------------

Point2 Mirror::perturbed_vertex(const Point2 &point, std::uint64_t frame) const {
  Point2 out = point;
  if (perturb_vertex_frame_ != 0 && frame >= perturb_vertex_frame_) {
    out[0] += 1.0f;  // gate5-design.md Q3c "perturb-vertex": first point's x + 1.0, recorded only
  }
  return out;
}

bool Mirror::geometry_texture(std::uint64_t texture, const char *op, Command *command) const {
  if (texture == 0 && canvas_texture_headless_ && canvas_texture_created_) {
    // D11: on a headless host that has created a canvas texture, RID() may be that texture.
    command->kind = CommandKind::Unsupported;
    command->name = op;
    command->unsupported_reason = UnsupportedCmdReason::CanvasTextureHeadless;
    return false;
  }
  if (!texture_ref(texture, &command->has_tex, &command->tex)) {
    command->kind = CommandKind::Unsupported;
    command->name = op;
    command->unsupported_reason = UnsupportedCmdReason::UnknownTexture;
    return false;
  }
  return true;
}

Mirror::Item *Mirror::geometry_item(std::uint64_t rid, const char *op, std::uint64_t frame) {
  if (dropped(op, frame)) {
    return nullptr;
  }
  return item_for(rid, op, frame);
}

void Mirror::add_line(std::uint64_t rid, const Point2 &from, const Point2 &to, const Color4 &color,
                      float width, bool antialiased, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Item *item = geometry_item(rid, "canvas_item_add_line", frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  command.kind = CommandKind::AddLine;
  command.antialiased = antialiased;
  command.line_from = perturbed_vertex(from, frame);
  command.line_to = to;
  command.color = color;
  command.width = width;
  push_command(item, std::move(command), frame);
}

void Mirror::add_polyline(std::uint64_t rid, std::vector<Point2> points,
                          std::vector<Color4> colors, float width, bool antialiased,
                          bool multiline, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Item *item = geometry_item(
      rid, multiline ? "canvas_item_add_multiline" : "canvas_item_add_polyline", frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  command.kind = multiline ? CommandKind::AddMultiline : CommandKind::AddPolyline;
  command.antialiased = antialiased;
  command.width = width;
  command.points = std::move(points);
  if (!command.points.empty()) {
    command.points[0] = perturbed_vertex(command.points[0], frame);
  }
  command.colors = std::move(colors);
  push_command(item, std::move(command), frame);
}

void Mirror::add_circle(std::uint64_t rid, const Point2 &position, float radius,
                        const Color4 &color, bool antialiased, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Item *item = geometry_item(rid, "canvas_item_add_circle", frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  command.kind = CommandKind::AddCircle;
  command.antialiased = antialiased;
  command.circle_position = position;  // Q3c: add_circle is outside perturb-vertex's scope
  command.circle_radius = radius;
  command.color = color;
  push_command(item, std::move(command), frame);
}

void Mirror::add_primitive(std::uint64_t rid, std::vector<Point2> points,
                           std::vector<Color4> colors, std::vector<Point2> uvs,
                           std::uint64_t texture, bool polygon, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  const char *op = polygon ? "canvas_item_add_polygon" : "canvas_item_add_primitive";
  Item *item = geometry_item(rid, op, frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  if (geometry_texture(texture, op, &command)) {
    command.kind = polygon ? CommandKind::AddPolygon : CommandKind::AddPrimitive;
    command.points = std::move(points);
    if (!command.points.empty()) {
      command.points[0] = perturbed_vertex(command.points[0], frame);
    }
    command.colors = std::move(colors);
    command.uvs = std::move(uvs);
  }
  push_command(item, std::move(command), frame);
}

void Mirror::add_triangle_array(std::uint64_t rid, std::vector<std::int32_t> indices,
                                std::vector<Point2> points, std::vector<Color4> colors,
                                std::vector<Point2> uvs, bool skinned, std::uint64_t texture,
                                std::int32_t count, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_add_triangle_array";
  Item *item = geometry_item(rid, kOp, frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  if (skinned) {
    // D16: bones or weights make it skinned geometry, typed, not copied.
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = UnsupportedCmdReason::SkinnedGeometry;
  } else if (geometry_texture(texture, kOp, &command)) {
    command.kind = CommandKind::AddTriangleArray;
    command.indices = std::move(indices);
    command.points = std::move(points);
    if (!command.points.empty()) {
      command.points[0] = perturbed_vertex(command.points[0], frame);
    }
    command.colors = std::move(colors);
    command.uvs = std::move(uvs);
    command.triangle_count = count;
  }
  push_command(item, std::move(command), frame);
}

void Mirror::add_nine_patch(std::uint64_t rid, const Rect4 &rect, const Rect4 &source,
                            std::uint64_t texture, const Point2 &margin_tl,
                            const Point2 &margin_br, std::int32_t x_axis, std::int32_t y_axis,
                            bool draw_center, const Color4 &modulate, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_add_nine_patch";
  Item *item = geometry_item(rid, kOp, frame);
  if (item == nullptr) {
    return;
  }
  static const AxisStretchMode kModes[] = {AxisStretchMode::Stretch, AxisStretchMode::Tile,
                                           AxisStretchMode::TileFit};
  Command command;
  if (x_axis < 0 || x_axis > 2 || y_axis < 0 || y_axis > 2) {
    // RenderingServer::NinePatchAxisMode has three values; anything else has no wire spelling.
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = UnsupportedCmdReason::UnsupportedOp;
  } else if (geometry_texture(texture, kOp, &command)) {
    command.kind = CommandKind::AddNinePatch;
    command.rect = rect;
    command.src = source;
    command.np_margin_tl = margin_tl;
    command.np_margin_br = margin_br;
    command.x_axis = kModes[x_axis];
    command.y_axis = kModes[y_axis];
    command.draw_center = draw_center;
    command.modulate = modulate;
  }
  push_command(item, std::move(command), frame);
}

void Mirror::add_set_transform(std::uint64_t rid, const Xform &transform, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Item *item = geometry_item(rid, "canvas_item_add_set_transform", frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  command.kind = CommandKind::AddSetTransform;
  command.transform = transform;
  push_command(item, std::move(command), frame);
}

void Mirror::add_clip_ignore(std::uint64_t rid, bool ignore, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Item *item = geometry_item(rid, "canvas_item_add_clip_ignore", frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  command.kind = CommandKind::AddClipIgnore;
  command.clip_ignore = ignore;
  push_command(item, std::move(command), frame);
}

// --- meshes (G5e; gate5-design.md D5-D8, Q3b) ------------------------------------------------

namespace {

MeshReason mesh_reason_from_text(const std::string &text) {
  if (text == "mesh-blend-shapes") {
    return MeshReason::MeshBlendShapes;
  }
  if (text == "payload-too-large") {
    return MeshReason::PayloadTooLarge;
  }
  return MeshReason::MeshFormat;
}

std::int32_t clamp_count(std::int64_t value) {
  return static_cast<std::int32_t>(std::max<std::int64_t>(value, 0));
}

// The offset of a GRM1 payload's first vertex float (magic, meta length, meta, the 40-byte
// geometry block), or 0 when the payload has no whole first vertex x (render-stream-4.md
// "Mesh payload").
std::size_t first_vertex_offset(const PayloadBytes &payload) {
  if (payload.size() < 12) {
    return 0;
  }
  const std::uint32_t meta_len = static_cast<std::uint32_t>(payload[8]) |
                                 (static_cast<std::uint32_t>(payload[9]) << 8) |
                                 (static_cast<std::uint32_t>(payload[10]) << 16) |
                                 (static_cast<std::uint32_t>(payload[11]) << 24);
  const std::size_t offset = 12 + static_cast<std::size_t>(meta_len) + 40;
  return offset + 4 <= payload.size() ? offset : 0;
}

}  // namespace

Mirror::Mesh *Mirror::find_mesh(std::uint64_t rid) {
  const auto it = mesh_by_rid_.find(rid);
  return it == mesh_by_rid_.end() ? nullptr : &meshes_.at(it->second);
}

Mirror::Mesh *Mirror::mesh_for(std::uint64_t rid, const char *op, std::uint64_t frame) {
  if (omit_op_matches(op, frame)) {
    ++stats_.dropped_omit_op;
    return nullptr;
  }
  Mesh *mesh = find_mesh(rid);
  if (mesh == nullptr) {
    ++stats_.mesh_unknown;
    return nullptr;
  }
  return mesh;
}

Mirror::MeshSurf Mirror::mesh_surface(const MeshSurfaceInput &input, std::uint64_t frame) const {
  MeshSurf out;
  out.primitive = input.copy.primitive;
  out.format = static_cast<std::int64_t>(input.copy.format);
  out.vertex_count = clamp_count(input.copy.vertex_count);
  out.index_count = clamp_count(input.copy.index_count);
  out.ok = input.copy.status == "ok" && input.bytes != nullptr && out.primitive >= 0 &&
           out.primitive < 5;
  if (!out.ok) {
    out.reason = mesh_reason_from_text(input.copy.reason);
    return out;
  }
  out.bytes = input.bytes;
  out.hash = input.copy.hash;
  if (perturb_vertex_frame_ != 0 && frame >= perturb_vertex_frame_ && out.vertex_count > 0) {
    // Q3c (G5e): the recorded payload's first vertex x + 1.0, as a new copy re-hashed; the
    // engine, the hook's retained buffers and the hook log keep the true bytes.
    const std::size_t offset = first_vertex_offset(*input.bytes);
    if (offset != 0) {
      auto copy = std::make_shared<PayloadBytes>(*input.bytes);
      float x = 0.0f;
      std::memcpy(&x, copy->data() + offset, sizeof(x));
      x += 1.0f;
      std::memcpy(copy->data() + offset, &x, sizeof(x));
      out.hash = sha256_hex(copy->data(), copy->size());
      out.bytes = std::move(copy);
    }
  }
  return out;
}

void Mirror::recompute_mesh_status(Mesh *mesh) {
  if (mesh->status == MeshStatus::Freed) {
    return;
  }
  for (const MeshSurf &surface : mesh->surfaces) {
    if (!surface.ok) {
      mesh->status = MeshStatus::Unsupported;
      mesh->has_reason = true;
      mesh->reason = surface.reason;
      return;
    }
  }
  mesh->status = MeshStatus::Ok;
  mesh->has_reason = false;
}

bool Mirror::mesh_referenced(std::uint32_t id) const {
  for (const auto &entry : items_) {
    for (const Command &command : entry.second.state.commands) {
      if (command.kind == CommandKind::AddMesh && command.mesh == id) {
        return true;
      }
    }
  }
  return false;
}

void Mirror::retire_mesh(std::uint32_t id) {
  const auto it = meshes_.find(id);
  if (it == meshes_.end()) {
    return;
  }
  Mesh &mesh = it->second;
  if (mesh.rid != 0) {
    mesh_by_rid_.erase(mesh.rid);
    mesh.rid = 0;
  }
  if (!mesh_referenced(id)) {
    meshes_.erase(it);
    return;
  }
  // render-stream-4.md "Mesh table": a tombstone keeps its id and version, drops its surfaces;
  // a command naming it draws nothing (gate5-design.md Q1d).
  mesh.status = MeshStatus::Freed;
  mesh.has_reason = false;
  mesh.surfaces.clear();
}

MeshEntry Mirror::wire_mesh(const Mesh &mesh) {
  MeshEntry out;
  out.id = mesh.id;
  out.status = mesh.status;
  out.version = mesh.version;
  out.origin = mesh.origin;  // G8r
  out.adopted_content = mesh.adopted_content;
  out.has_reason = mesh.status == MeshStatus::Unsupported && mesh.has_reason;
  out.reason = mesh.reason;
  out.has_aabb = mesh.status != MeshStatus::Freed;
  if (out.has_aabb) {
    out.custom_aabb = mesh.custom_aabb;
  }
  if (mesh.status == MeshStatus::Ok) {
    out.surfaces.reserve(mesh.surfaces.size());
    for (const MeshSurf &surface : mesh.surfaces) {
      MeshSurface wire;
      wire.hash = surface.hash;
      wire.payload_bytes = surface.bytes != nullptr ? surface.bytes->size() : 0;
      wire.primitive = static_cast<Primitive>(surface.primitive);
      wire.format = surface.format;
      wire.vertex_count = surface.vertex_count;
      wire.index_count = surface.index_count;
      out.surfaces.push_back(std::move(wire));
    }
  }
  return out;
}

void Mirror::mesh_create(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || dropped_identity("mesh_create", frame)) {
    return;
  }
  const auto stale = mesh_by_rid_.find(rid);
  if (stale != mesh_by_rid_.end()) {
    retire_mesh(stale->second);  // a recycled RID value: the old id is gone
  }
  Mesh mesh;
  mesh.id = next_mesh_id_++;
  mesh.rid = rid;
  mesh_by_rid_[rid] = mesh.id;
  meshes_.emplace(mesh.id, std::move(mesh));
}

void Mirror::mesh_create_from_surfaces(std::uint64_t rid,
                                       const std::vector<MeshSurfaceInput> &surfaces,
                                       std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || dropped_identity("mesh_create_from_surfaces", frame)) {
    return;
  }
  const auto stale = mesh_by_rid_.find(rid);
  if (stale != mesh_by_rid_.end()) {
    retire_mesh(stale->second);
  }
  Mesh mesh;
  mesh.id = next_mesh_id_++;
  mesh.rid = rid;
  for (const MeshSurfaceInput &input : surfaces) {
    mesh.surfaces.push_back(mesh_surface(input, frame));
  }
  recompute_mesh_status(&mesh);
  mesh_by_rid_[rid] = mesh.id;
  meshes_.emplace(mesh.id, std::move(mesh));
}

void Mirror::mesh_adopt(std::uint64_t rid, const std::vector<MeshSurfaceInput> &surfaces,
                        const std::array<float, 6> &custom_aabb, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || mesh_by_rid_.count(rid) != 0) {
    return;
  }
  ++epoch_;
  Mesh mesh;
  mesh.id = next_mesh_id_++;
  mesh.rid = rid;
  mesh.origin = Origin::Adopted;
  mesh.adopted_content = AdoptedContent::Creation;
  mesh.custom_aabb = custom_aabb;
  for (const MeshSurfaceInput &input : surfaces) {
    mesh.surfaces.push_back(mesh_surface(input, frame));
  }
  recompute_mesh_status(&mesh);
  mesh_by_rid_[rid] = mesh.id;
  meshes_.emplace(mesh.id, std::move(mesh));
}

void Mirror::mesh_add_surface(std::uint64_t rid, const MeshSurfaceInput &surface,
                              std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Mesh *mesh = mesh_for(rid, "mesh_add_surface", frame);
  if (mesh == nullptr) {
    return;
  }
  ++epoch_;
  mesh->surfaces.push_back(mesh_surface(surface, frame));
  mesh->version += 1;
  recompute_mesh_status(mesh);
}

void Mirror::mesh_surface_update_region(std::uint64_t rid, const char *op, std::int32_t surface,
                                        bool applied, const MeshSurfaceInput *updated,
                                        std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Mesh *mesh = mesh_for(rid, op, frame);
  if (mesh == nullptr || !applied) {
    return;  // D8: a rejected (out of bounds, empty) update changes nothing, as in GLES3
  }
  ++epoch_;
  mesh->version += 1;
  if (updated != nullptr && surface >= 0 &&
      static_cast<std::size_t>(surface) < mesh->surfaces.size()) {
    mesh->surfaces[static_cast<std::size_t>(surface)] = mesh_surface(*updated, frame);
  }
  recompute_mesh_status(mesh);
}

void Mirror::mesh_surface_remove(std::uint64_t rid, std::int32_t surface, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Mesh *mesh = mesh_for(rid, "mesh_surface_remove", frame);
  if (mesh == nullptr || surface < 0 ||
      static_cast<std::size_t>(surface) >= mesh->surfaces.size()) {
    return;
  }
  ++epoch_;
  mesh->surfaces.erase(mesh->surfaces.begin() + surface);
  mesh->version += 1;
  recompute_mesh_status(mesh);
}

void Mirror::mesh_clear(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Mesh *mesh = mesh_for(rid, "mesh_clear", frame);
  if (mesh == nullptr) {
    return;
  }
  ++epoch_;
  mesh->surfaces.clear();
  mesh->version += 1;
  if (mesh->origin == Origin::Adopted) {
    mesh->adopted_content = AdoptedContent::Current;  // G8r: nothing of the creation copy is left
  }
  recompute_mesh_status(mesh);
}

void Mirror::mesh_set_custom_aabb(std::uint64_t rid, const std::array<float, 6> &aabb,
                                  std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Mesh *mesh = mesh_for(rid, "mesh_set_custom_aabb", frame);
  if (mesh == nullptr) {
    return;
  }
  ++epoch_;
  mesh->custom_aabb = aabb;
  mesh->version += 1;
}

void Mirror::add_mesh(std::uint64_t rid, std::uint64_t mesh_rid, const Xform &transform,
                      const Color4 &modulate, std::uint64_t texture, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_add_mesh";
  Item *item = geometry_item(rid, kOp, frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  const Mesh *mesh = find_mesh(mesh_rid);
  if (mesh == nullptr) {
    // render-stream-4.md "Command": a mesh the capture never saw created (or RID()).
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = UnsupportedCmdReason::UnknownMesh;
  } else if (geometry_texture(texture, kOp, &command)) {
    command.kind = CommandKind::AddMesh;
    command.mesh = mesh->id;
    command.transform = transform;
    command.modulate = modulate;
  }
  push_command(item, std::move(command), frame);
}

void Mirror::set_texture_filter(std::uint64_t rid, std::int32_t filter, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_set_default_texture_filter";
  if (dropped(kOp, frame)) {
    return;
  }
  Item *item = item_for(rid, kOp, frame);
  if (item == nullptr || filter < 0 ||
      filter > static_cast<std::int32_t>(Filter::LinearMipmapsAnisotropic)) {
    return;
  }
  item->state.texture_filter = static_cast<Filter>(filter);
}

void Mirror::set_texture_repeat(std::uint64_t rid, std::int32_t repeat, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_set_default_texture_repeat";
  if (dropped(kOp, frame)) {
    return;
  }
  Item *item = item_for(rid, kOp, frame);
  if (item == nullptr || repeat < 0 || repeat > static_cast<std::int32_t>(Repeat::Mirror)) {
    return;
  }
  item->state.texture_repeat = static_cast<Repeat>(repeat);
}

void Mirror::set_texture_defaults(Filter filter, Repeat repeat) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  if (filter != Filter::Default) {
    default_filter_ = filter;
  }
  if (repeat != Repeat::Default) {
    default_repeat_ = repeat;
  }
}

void Mirror::viewport_set_texture_filter(std::uint64_t viewport, std::int32_t filter,
                                         std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "viewport_set_default_canvas_item_texture_filter";
  if (dropped(kOp, frame)) {
    return;
  }
  if (viewport != root_viewport_rid_ || root_viewport_rid_ == 0) {
    session_unsupported(kOp, UnsupportedReason::NonRootViewport);
    return;
  }
  if (filter <= 0 || filter > static_cast<std::int32_t>(Filter::LinearMipmapsAnisotropic)) {
    return;
  }
  default_filter_ = static_cast<Filter>(filter);
}

void Mirror::viewport_set_texture_repeat(std::uint64_t viewport, std::int32_t repeat,
                                         std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "viewport_set_default_canvas_item_texture_repeat";
  if (dropped(kOp, frame)) {
    return;
  }
  if (viewport != root_viewport_rid_ || root_viewport_rid_ == 0) {
    session_unsupported(kOp, UnsupportedReason::NonRootViewport);
    return;
  }
  if (repeat <= 0 || repeat > static_cast<std::int32_t>(Repeat::Mirror)) {
    return;
  }
  default_repeat_ = static_cast<Repeat>(repeat);
}

void Mirror::texture_2d_create(std::uint64_t rid, const PayloadCopy &copy, PayloadPtr bytes,
                               std::uint64_t frame, std::shared_ptr<TextureJob> job) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || dropped_identity("texture_2d_create", frame)) {
    return;
  }
  const auto stale = texture_by_rid_.find(rid);
  if (stale != texture_by_rid_.end()) {
    retire_texture(stale->second);  // a recycled RID value: the old id is gone
  }
  Texture texture;
  texture.id = next_texture_id_++;
  texture.rid = rid;
  texture.kind = TextureKind::Image;
  texture.version = 1;
  texture.copy = copy;
  take_copy(copy, std::move(bytes), &texture.status, &texture.has_reason, &texture.reason,
            &texture.bytes, job != nullptr);
  if (texture.status == TextureStatus::Ok && job != nullptr) {
    texture.job = std::move(job);
  }
  texture_by_rid_[rid] = texture.id;
  textures_.emplace(texture.id, std::move(texture));
}

void Mirror::texture_adopt(std::uint64_t rid, const PayloadCopy &copy, PayloadPtr bytes,
                           AdoptedContent content, std::uint64_t frame,
                           std::shared_ptr<TextureJob> job) {
  (void)frame;
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || texture_by_rid_.count(rid) != 0) {
    return;  // adoption only ever names a RID the table does not hold
  }
  ++epoch_;
  Texture texture;
  texture.id = next_texture_id_++;
  texture.rid = rid;
  texture.kind = TextureKind::Image;
  texture.version = 1;
  texture.origin = Origin::Adopted;
  texture.adopted_content = content == AdoptedContent::None ? AdoptedContent::Creation : content;
  texture.copy = copy;
  take_copy(copy, std::move(bytes), &texture.status, &texture.has_reason, &texture.reason,
            &texture.bytes, job != nullptr);
  if (texture.status == TextureStatus::Ok && job != nullptr) {
    texture.job = std::move(job);
  }
  texture_by_rid_[rid] = texture.id;
  textures_.emplace(texture.id, std::move(texture));
}

bool Mirror::knows_texture(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return texture_by_rid_.count(rid) != 0;
}

bool Mirror::knows_mesh(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return mesh_by_rid_.count(rid) != 0;
}

void Mirror::shader_adopt(std::uint64_t rid, const ShaderCodeInput &code, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || shader_by_rid_.count(rid) != 0) {
    return;  // adoption only ever names a RID the table does not hold
  }
  ++epoch_;
  Shader shader;
  shader.id = next_shader_id_++;
  shader.rid = rid;
  shader.origin = Origin::Adopted;
  take_shader_code(&shader, code, frame);
  shader_by_rid_[rid] = shader.id;
  shaders_.emplace(shader.id, std::move(shader));
}

void Mirror::shader_adopt_refused(std::uint64_t rid, ShaderReason reason, std::uint64_t frame) {
  (void)frame;
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || shader_by_rid_.count(rid) != 0) {
    return;
  }
  ++epoch_;
  Shader shader;
  shader.id = next_shader_id_++;
  shader.rid = rid;
  shader.origin = Origin::Adopted;
  shader.refused = true;
  shader.refused_reason = reason;
  shader_by_rid_[rid] = shader.id;
  shaders_.emplace(shader.id, std::move(shader));
}

void Mirror::material_adopt(std::uint64_t rid, std::uint64_t frame) {
  (void)frame;
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || material_by_rid_.count(rid) != 0) {
    return;
  }
  ++epoch_;
  Material material;
  material.id = next_material_id_++;
  material.rid = rid;
  material.origin = Origin::Adopted;
  material_by_rid_[rid] = material.id;
  materials_.emplace(material.id, std::move(material));
}

bool Mirror::knows_shader(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return shader_by_rid_.count(rid) != 0;
}

bool Mirror::knows_material(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return material_by_rid_.count(rid) != 0;
}

std::uint64_t Mirror::material_refs_epoch() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return material_refs_epoch_;
}

Mirror::PendingMaterialRefs Mirror::pending_material_refs() const {
  std::lock_guard<std::mutex> lock(mutex_);
  PendingMaterialRefs out;
  std::map<std::uint32_t, std::size_t> by_material;  // material id -> index in out.materials
  for (const auto &entry : materials_) {
    if (entry.second.shader_unknown && entry.second.unknown_shader_rid != 0) {
      by_material[entry.first] = out.materials.size();
      PendingMaterialRefs::MaterialRef ref;
      ref.material = entry.second.rid;
      ref.shader = entry.second.unknown_shader_rid;
      out.materials.push_back(std::move(ref));
    }
  }
  for (const auto &entry : items_) {
    const Item &item = entry.second;
    if (item.rid == 0) {
      continue;
    }
    if (item.unknown_material && item.unknown_material_rid != 0) {
      out.items.push_back({item.rid, item.unknown_material_rid});
    } else if (item.state.has_material) {
      const auto it = by_material.find(item.state.material);
      if (it != by_material.end()) {
        out.materials[it->second].items.push_back(item.rid);
      }
    }
  }
  return out;
}

void Mirror::texture_2d_placeholder_create(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || dropped_identity("texture_2d_placeholder_create", frame)) {
    return;
  }
  const auto stale = texture_by_rid_.find(rid);
  if (stale != texture_by_rid_.end()) {
    retire_texture(stale->second);
  }
  Texture texture;
  texture.id = next_texture_id_++;
  texture.rid = rid;
  texture.kind = TextureKind::Placeholder;
  texture.status = TextureStatus::Ok;
  texture.version = 1;
  texture_by_rid_[rid] = texture.id;
  textures_.emplace(texture.id, std::move(texture));
}

void Mirror::texture_2d_update(std::uint64_t rid, const PayloadCopy &copy, PayloadPtr bytes,
                               int layer, std::uint64_t frame, std::shared_ptr<TextureJob> job) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (omit_op_matches("texture_2d_update", frame)) {
    ++stats_.dropped_omit_op;
    return;
  }
  Texture *texture = find_texture(rid);
  if (texture == nullptr) {
    // An update to a texture the capture never saw created changes nothing the stream shows.
    ++stats_.texture_update_unknown;
    return;
  }
  ++epoch_;
  texture->version += 1;
  // G8kw: the shape compared below is the hook's (predicted) one, never the worker's content, so
  // a pending previous copy decides exactly as a finished one; its own job is superseded.
  texture->job.reset();
  // G8ku (D6, D12(a)): the content changed, so its variants reset, and an updated texture never
  // gets a Basis variant again (an encode still running is discarded when it finishes).
  reset_basis(texture);
  texture->updated = true;
  if (layer != 0) {
    texture->status = TextureStatus::Unsupported;
    texture->has_reason = true;
    texture->reason = TextureReason::LayeredUpdate;
    texture->bytes.reset();
  } else if (texture->kind != TextureKind::Image || !same_shape(texture->copy, copy)) {
    texture->status = TextureStatus::Unsupported;
    texture->has_reason = true;
    texture->reason = TextureReason::UpdateShapeMismatch;
    texture->bytes.reset();
  } else {
    texture->copy = copy;
    // G8r: an accepted update replaces the whole content (layer 0, same shape), so an adopted
    // entry's bytes are the hooks' from here on.
    if (texture->origin == Origin::Adopted) {
      texture->adopted_content = AdoptedContent::Current;
    }
    take_copy(copy, std::move(bytes), &texture->status, &texture->has_reason, &texture->reason,
              &texture->bytes, job != nullptr);
    if (texture->status == TextureStatus::Ok && job != nullptr) {
      texture->job = std::move(job);
    }
  }
}

void Mirror::texture_replace(std::uint64_t t_rid, std::uint64_t b_rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (omit_op_matches("texture_replace", frame)) {
    ++stats_.dropped_omit_op;
    return;
  }
  if (t_rid == b_rid) {
    return;  // a no-op in the engine (texture_storage.cpp:1402-1404)
  }
  Texture *t = find_texture(t_rid);
  Texture *b = find_texture(b_rid);
  if (t == nullptr && b == nullptr) {
    return;
  }
  ++epoch_;
  if (t != nullptr) {
    t->version += 1;
    if (b != nullptr) {
      t->kind = b->kind;
      t->status = b->status;
      t->has_reason = b->has_reason;
      t->reason = b->reason;
      t->copy = b->copy;
      t->bytes = b->bytes;
      t->job = b->job;  // G8kw: a pending payload moves with the rest
      // G8ku: so does b's Basis state (its encode is of exactly this content; the version check
      // in service_basis is against t's raised version, so a running encode becomes stale).
      t->updated = b->updated;
      t->basis = b->basis;
      t->uastc_hash = b->uastc_hash;
      t->uastc_params = b->uastc_params;
      t->uastc_bytes = b->uastc_bytes;
      t->basis_decided = b->basis_decided;
      // G8r: t's content is now b's; an adopted t keeps origin and inherits b's trust.
      if (t->origin == Origin::Adopted) {
        t->adopted_content =
            b->origin == Origin::Adopted ? b->adopted_content : AdoptedContent::Current;
      }
    } else {
      t->status = TextureStatus::Unsupported;
      t->has_reason = true;
      t->reason = TextureReason::UnknownTexture;
      t->bytes.reset();
      t->job.reset();
      reset_basis(t);
    }
  }
  if (b != nullptr) {
    // The storage frees the by-texture itself (texture_storage.cpp:1434): its id leaves the
    // table (or stays as a tombstone while a command still names it).
    retire_texture(b->id);
  }
}

// --- canvas textures (G2d) ------------------------------------------------------------

void Mirror::canvas_texture_create(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped_identity("canvas_texture_create", frame)) {
    return;
  }
  // D11 (gate5-design.md, G5d): only a create that handed back RID() -- the dummy storage's
  // answer -- makes RID() on the /4 geometry ops ambiguous. With the opt-in headless shim
  // (protocol/canvas-texture-headless.md "Experiment (a) result") every create made while armed
  // carries a private, non-null RID, so RID() can only mean "no texture" and nothing is refused;
  // with the shim off every headless create is RID(), exactly as before.
  if (rid == 0) {
    canvas_texture_created_ = true;
    return;
  }
  const auto stale = texture_by_rid_.find(rid);
  if (stale != texture_by_rid_.end()) {
    retire_texture(stale->second);  // a recycled RID value: the old id is gone
  }
  Texture texture;
  texture.id = next_texture_id_++;
  texture.rid = rid;
  texture.kind = TextureKind::Canvas;
  texture.status = TextureStatus::Ok;
  texture.version = 1;
  // diffuse/filter/repeat default to {null, default, default} (Texture's own defaults).
  texture_by_rid_[rid] = texture.id;
  textures_.emplace(texture.id, std::move(texture));
}

void Mirror::canvas_texture_set_channel(std::uint64_t rid, std::int32_t channel,
                                        std::uint64_t texture_rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_texture_set_channel";
  if (dropped(kOp, frame)) {
    return;
  }
  if (channel < 0 || channel > 2) {
    return;  // out of range: the server's ERR_FAIL_INDEX refuses it too
  }
  Texture *canvas = find_texture(rid);
  if (canvas == nullptr || canvas->kind != TextureKind::Canvas) {
    return;
  }
  bool changed = false;
  if (channel == 0) {  // CANVAS_TEXTURE_CHANNEL_DIFFUSE
    bool has_tex = false;
    std::uint32_t tex_id = 0;
    const bool known = texture_ref(texture_rid, &has_tex, &tex_id);
    const bool new_unknown = !known;
    const bool new_has_diffuse = known && has_tex;
    const std::uint32_t new_diffuse_id = new_has_diffuse ? tex_id : 0;
    if (canvas->has_diffuse != new_has_diffuse || canvas->diffuse_id != new_diffuse_id ||
        canvas->diffuse_unknown != new_unknown) {
      canvas->has_diffuse = new_has_diffuse;
      canvas->diffuse_id = new_diffuse_id;
      canvas->diffuse_unknown = new_unknown;
      changed = true;
    }
  } else {  // CANVAS_TEXTURE_CHANNEL_NORMAL / _SPECULAR: only non-null-ness is wire-visible
    const bool non_null = texture_rid != 0;
    bool &flag = channel == 1 ? canvas->normal_set : canvas->specular_set;
    if (flag != non_null) {
      flag = non_null;
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  canvas->version += 1;
  // render-stream-2.md "Texture" reasons: a non-null normal/specular channel makes the entry
  // unsupported (canvas-texture-channel); clearing both back to null makes it ok again. An
  // unresolvable diffuse RID is unknown-texture, unless a channel reason already applies.
  const bool unsupported = canvas->normal_set || canvas->specular_set || canvas->diffuse_unknown;
  canvas->status = unsupported ? TextureStatus::Unsupported : TextureStatus::Ok;
  canvas->has_reason = unsupported;
  canvas->reason = (canvas->normal_set || canvas->specular_set)
                       ? TextureReason::CanvasTextureChannel
                       : TextureReason::UnknownTexture;
}

void Mirror::canvas_texture_set_filter(std::uint64_t rid, std::int32_t filter,
                                       std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_texture_set_texture_filter";
  if (dropped(kOp, frame)) {
    return;
  }
  Texture *canvas = find_texture(rid);
  if (canvas == nullptr || canvas->kind != TextureKind::Canvas || filter < 0 ||
      filter > static_cast<std::int32_t>(Filter::LinearMipmapsAnisotropic)) {
    return;
  }
  const Filter value = static_cast<Filter>(filter);
  if (canvas->filter == value) {
    return;
  }
  canvas->filter = value;
  canvas->version += 1;
}

void Mirror::canvas_texture_set_repeat(std::uint64_t rid, std::int32_t repeat,
                                       std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_texture_set_texture_repeat";
  if (dropped(kOp, frame)) {
    return;
  }
  Texture *canvas = find_texture(rid);
  if (canvas == nullptr || canvas->kind != TextureKind::Canvas || repeat < 0 ||
      repeat > static_cast<std::int32_t>(Repeat::Mirror)) {
    return;
  }
  const Repeat value = static_cast<Repeat>(repeat);
  if (canvas->repeat == value) {
    return;
  }
  canvas->repeat = value;
  canvas->version += 1;
}

std::uint64_t Mirror::spurious_texture_update(std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  (void)frame;
  for (auto &entry : textures_) {
    Texture &texture = entry.second;
    if (texture.job != nullptr) {
      texture.job->wait();  // G8kw: the sabotage re-copies bytes, so it needs them
      settle(&texture);
    }
    if (texture.kind == TextureKind::Image && texture.status == TextureStatus::Ok &&
        texture.rid != 0 && texture.bytes != nullptr) {
      ++epoch_;
      texture.version += 1;
      texture.bytes = std::make_shared<const PayloadBytes>(*texture.bytes);
      return texture.rid;
    }
  }
  return 0;
}

// --- shaders, materials, item and canvas material state (G55d) -----------------------------------

namespace {

bool shader_mode_from_text(const std::string &text, ShaderMode *out) {
  static const std::pair<const char *, ShaderMode> kModes[] = {
      {"canvas_item", ShaderMode::CanvasItem}, {"spatial", ShaderMode::Spatial},
      {"particles", ShaderMode::Particles},    {"sky", ShaderMode::Sky},
      {"fog", ShaderMode::Fog},
  };
  for (const auto &entry : kModes) {
    if (text == entry.first) {
      *out = entry.second;
      return true;
    }
  }
  return false;
}

bool shader_reason_from_text(const std::string &text, ShaderReason *out) {
  static const std::pair<const char *, ShaderReason> kReasons[] = {
      {"shader-mode", ShaderReason::ShaderMode},
      {"shader-screen-texture", ShaderReason::ShaderScreenTexture},
      {"shader-sdf", ShaderReason::ShaderSdf},
      {"shader-time", ShaderReason::ShaderTime},
      {"shader-global-uniform", ShaderReason::ShaderGlobalUniform},
      {"shader-excluded", ShaderReason::ShaderExcluded},
      {"payload-too-large", ShaderReason::PayloadTooLarge},
      {"payload-unavailable", ShaderReason::PayloadUnavailable},
      {"shader-adopt-include", ShaderReason::ShaderAdoptInclude},
  };
  for (const auto &entry : kReasons) {
    if (text == entry.first) {
      *out = entry.second;
      return true;
    }
  }
  return false;
}

bool shader_use_from_text(const std::string &text, ShaderUse *out) {
  static const std::pair<const char *, ShaderUse> kUses[] = {
      {"global_uniform", ShaderUse::GlobalUniform}, {"instance_uniform", ShaderUse::InstanceUniform},
      {"light", ShaderUse::Light},                  {"screen_texture", ShaderUse::ScreenTexture},
      {"sdf", ShaderUse::Sdf},                      {"time", ShaderUse::Time},
  };
  for (const auto &entry : kUses) {
    if (text == entry.first) {
      *out = entry.second;
      return true;
    }
  }
  return false;
}

bool blend_from_text(const std::string &text, BlendMode *out) {
  static const std::pair<const char *, BlendMode> kModes[] = {
      {"mix", BlendMode::Mix},  {"add", BlendMode::Add},
      {"sub", BlendMode::Sub},  {"mul", BlendMode::Mul},
      {"premul_alpha", BlendMode::PremulAlpha}, {"disabled", BlendMode::Disabled},
  };
  for (const auto &entry : kModes) {
    if (text == entry.first) {
      *out = entry.second;
      return true;
    }
  }
  return false;
}

bool light_from_text(const std::string &text, LightMode *out) {
  static const std::pair<const char *, LightMode> kModes[] = {
      {"normal", LightMode::Normal}, {"unshaded", LightMode::Unshaded},
      {"light_only", LightMode::LightOnly},
  };
  for (const auto &entry : kModes) {
    if (text == entry.first) {
      *out = entry.second;
      return true;
    }
  }
  return false;
}

// rs_variant.h's spelling (a packed array names its element type) -> the wire's VariantType.
bool variant_type_of(const DecodedParam &value, VariantType *out) {
  static const std::pair<const char *, VariantType> kScalars[] = {
      {"nil", VariantType::Nil},
      {"bool", VariantType::Bool},
      {"int", VariantType::Int},
      {"float", VariantType::Float},
      {"vector2", VariantType::Vector2},
      {"vector2i", VariantType::Vector2i},
      {"rect2", VariantType::Rect2},
      {"rect2i", VariantType::Rect2i},
      {"vector3", VariantType::Vector3},
      {"vector3i", VariantType::Vector3i},
      {"transform2d", VariantType::Transform2D},
      {"vector4", VariantType::Vector4},
      {"vector4i", VariantType::Vector4i},
      {"plane", VariantType::Plane},
      {"quaternion", VariantType::Quaternion},
      {"aabb", VariantType::Aabb},
      {"basis", VariantType::Basis},
      {"transform3d", VariantType::Transform3D},
      {"projection", VariantType::Projection},
      {"color", VariantType::Color},
      {"rid", VariantType::Rid},
  };
  static const std::pair<const char *, VariantType> kPacked[] = {
      {"int32", VariantType::PackedInt32Array},     {"int64", VariantType::PackedInt64Array},
      {"float32", VariantType::PackedFloat32Array}, {"float64", VariantType::PackedFloat64Array},
      {"vector2", VariantType::PackedVector2Array}, {"vector3", VariantType::PackedVector3Array},
      {"vector4", VariantType::PackedVector4Array}, {"color", VariantType::PackedColorArray},
  };
  if (value.packed) {
    for (const auto &entry : kPacked) {
      if (value.type == entry.first) {
        *out = entry.second;
        return true;
      }
    }
    return false;
  }
  for (const auto &entry : kScalars) {
    if (value.type == entry.first) {
      *out = entry.second;
      return true;
    }
  }
  return false;
}

// The code a GRP1 payload carries (magic, u32le meta length, meta, then the code to the end).
bool payload_code(const PayloadBytes &payload, std::string *code) {
  if (payload.size() < 12) {
    return false;
  }
  const std::uint32_t meta_len = static_cast<std::uint32_t>(payload[8]) |
                                 (static_cast<std::uint32_t>(payload[9]) << 8) |
                                 (static_cast<std::uint32_t>(payload[10]) << 16) |
                                 (static_cast<std::uint32_t>(payload[11]) << 24);
  const std::size_t start = 12u + static_cast<std::size_t>(meta_len);
  if (start > payload.size()) {
    return false;
  }
  code->assign(reinterpret_cast<const char *>(payload.data()) + start, payload.size() - start);
  return true;
}

// Q3c: true when `code` contains the identifier `fragment` (outside comments, not after `.`) and
// its last non-whitespace character is `}`, whose offset goes to `*close`.
bool perturbable_code(const std::string &code, std::size_t *close) {
  bool has_fragment = false;
  const std::size_t n = code.size();
  std::size_t i = 0;
  char prev = 0;
  while (i < n) {
    const char c = code[i];
    if (c == '/' && i + 1 < n && code[i + 1] == '/') {
      while (i < n && code[i] != '\n') {
        ++i;
      }
      continue;
    }
    if (c == '/' && i + 1 < n && code[i + 1] == '*') {
      const std::size_t end = code.find("*/", i + 2);
      i = end == std::string::npos ? n : end + 2;
      continue;
    }
    const bool start = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
    if (start) {
      std::size_t j = i + 1;
      while (j < n && ((code[j] >= 'A' && code[j] <= 'Z') || (code[j] >= 'a' && code[j] <= 'z') ||
                       (code[j] >= '0' && code[j] <= '9') || code[j] == '_')) {
        ++j;
      }
      if (prev != '.' && code.compare(i, j - i, "fragment") == 0) {
        has_fragment = true;
      }
      prev = 'a';
      i = j;
      continue;
    }
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
      prev = c;
    }
    ++i;
  }
  if (!has_fragment) {
    return false;
  }
  std::size_t last = n;
  while (last > 0) {
    const char c = code[last - 1];
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') {
      break;
    }
    --last;
  }
  if (last == 0 || code[last - 1] != '}') {
    return false;
  }
  *close = last - 1;
  return true;
}

}  // namespace

bool Mirror::shader_code_of(std::uint64_t rid, std::string *code) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = shader_by_rid_.find(rid);
  if (it == shader_by_rid_.end()) {
    return false;
  }
  const Shader &shader = shaders_.at(it->second);
  return shader.has_code && shader.bytes != nullptr && payload_code(*shader.bytes, code);
}

void Mirror::shader_rebind(std::uint64_t old_rid, std::uint64_t new_rid) {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = shader_by_rid_.find(old_rid);
  if (it == shader_by_rid_.end() || new_rid == 0 || shader_by_rid_.count(new_rid) != 0) {
    return;
  }
  const std::uint32_t id = it->second;
  shader_by_rid_.erase(it);
  shader_by_rid_[new_rid] = id;
  shaders_.at(id).rid = new_rid;
}

void Mirror::set_shader_policy(ShaderPolicy policy) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  shader_policy_ = policy;
}

void Mirror::set_perturb_shader(std::uint64_t from_frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  perturb_shader_frame_ = from_frame;
}

Mirror::Shader *Mirror::find_shader(std::uint64_t rid) {
  const auto it = shader_by_rid_.find(rid);
  return it == shader_by_rid_.end() ? nullptr : &shaders_.at(it->second);
}

Mirror::Material *Mirror::find_material(std::uint64_t rid) {
  const auto it = material_by_rid_.find(rid);
  return it == material_by_rid_.end() ? nullptr : &materials_.at(it->second);
}

void Mirror::take_shader_code(Shader *shader, const ShaderCodeInput &code,
                              std::uint64_t frame) const {
  shader->has_code = true;
  shader->copy = code.copy;
  shader->bytes = code.bytes;
  if (perturb_shader_frame_ == 0 || frame < perturb_shader_frame_ || code.copy.builtin ||
      code.bytes == nullptr) {
    return;
  }
  // Q3c (perturb-shader): the recorded code only; the engine and the hook log keep the true code.
  std::string text;
  std::size_t close = 0;
  if (!payload_code(*code.bytes, &text) || !perturbable_code(text, &close)) {
    return;
  }
  text.insert(close, "\tCOLOR.rgb = vec3(1.0) - COLOR.rgb;\n");
  auto payload = std::make_shared<PayloadBytes>(encode_payload(text));
  shader->copy.hash = sha256_hex(payload->data(), payload->size());
  shader->copy.payload_bytes = static_cast<std::int64_t>(payload->size());
  shader->copy.code_bytes = static_cast<std::int64_t>(text.size());
  shader->bytes = std::move(payload);
}

ShaderEntry Mirror::wire_shader(const Shader &shader) const {
  ShaderEntry out;
  out.id = shader.id;
  out.origin = shader.origin;
  out.version = shader.version;
  for (const auto &entry : shader.default_textures) {
    DefaultTextureRef ref;
    ref.name = entry.first.first;
    ref.index = entry.first.second;
    ref.tex = entry.second;
    out.default_textures.push_back(std::move(ref));
  }
  if (shader.refused) {
    // G8m (Q5): an adopted shader whose code could not be recovered keeps the no-code shape.
    out.status = ShaderStatus::Unsupported;
    out.has_reason = true;
    out.reason = shader.refused_reason;
    return out;
  }
  if (!shader.has_code) {
    return out;  // render-stream-5.md "Shader table": mode, source, hash null, payload_bytes 0
  }
  const ShaderCopy &copy = shader.copy;
  ShaderMode mode = ShaderMode::CanvasItem;
  if (!shader_mode_from_text(copy.mode, &mode)) {
    // Code with no (or no known) `shader_type`: GLES3 derives no mode from it and draws the
    // material as none (g3ms.h:651-658). The wire has no spelling for that mode, so the entry keeps
    // the no-code shape and is refused with shader-mode (G55d decision; never seen in a fixture).
    out.status = ShaderStatus::Unsupported;
    out.has_reason = true;
    out.reason = ShaderReason::ShaderMode;
    return out;
  }
  out.has_mode = true;
  out.mode = mode;
  out.has_source = true;
  out.source = ShaderSource::Payload;
  out.has_hash = !copy.hash.empty();
  out.hash = copy.hash;
  out.payload_bytes = static_cast<std::uint64_t>(std::max<std::int64_t>(copy.payload_bytes, 0));
  if (copy.builtin) {
    BuiltinCanvasItemMaterial builtin;
    if (blend_from_text(copy.builtin_blend_mode, &builtin.blend_mode) &&
        light_from_text(copy.builtin_light_mode, &builtin.light_mode)) {
      builtin.particles_animation = copy.builtin_particles_animation;
      out.has_builtin = true;
      out.builtin = builtin;
    }
  }
  for (const std::string &use : copy.uses) {
    ShaderUse value;
    if (shader_use_from_text(use, &value)) {
      out.uses.push_back(value);
    }
  }
  std::sort(out.uses.begin(), out.uses.end(), [](ShaderUse a, ShaderUse b) {
    return std::string(to_wire(a)) < std::string(to_wire(b));
  });
  out.uses.erase(std::unique(out.uses.begin(), out.uses.end()), out.uses.end());
  if (copy.status != "ok") {
    out.status = ShaderStatus::Unsupported;
    out.has_reason = true;
    if (!shader_reason_from_text(copy.reason, &out.reason)) {
      out.reason = ShaderReason::PayloadUnavailable;
    }
  }
  // D4: the policy never touches engine-generated CanvasItemMaterial code (D7).
  if (!out.has_builtin && shader_policy_ != ShaderPolicy::Source) {
    out.source = ShaderSource::Withheld;
    if (shader_policy_ == ShaderPolicy::Exclude && out.status == ShaderStatus::Ok) {
      out.status = ShaderStatus::Unsupported;
      out.has_reason = true;
      out.reason = ShaderReason::ShaderExcluded;
    }
  }
  return out;
}

MaterialEntry Mirror::wire_material(const Material &material) {
  MaterialEntry out;
  out.id = material.id;
  out.origin = material.origin;
  out.version = material.version;
  out.has_shader = material.has_shader;
  out.shader = material.shader;
  if (material.shader_unknown) {
    out.status = MaterialStatus::Unsupported;
    out.has_reason = true;
    out.reason = MaterialReason::UnknownShader;
  }
  const Material::WireParams &wire = wire_params(material);
  out.params = wire.params;
  if (wire.unsupported && out.status == MaterialStatus::Ok) {
    out.status = MaterialStatus::Unsupported;
    out.has_reason = true;
    out.reason = wire.reason;
  }
  return out;
}

const Mirror::Material::WireParams &Mirror::wire_params(const Material &material) {
  Material::WireParams &wire = material.wire;
  if (wire.version == material.version) {
    return wire;
  }
  std::vector<Param> params;
  params.reserve(material.params.size());
  wire.unsupported = false;
  wire.reason = MaterialReason::ParamType;
  wire.textures.clear();
  for (const auto &entry : material.params) {
    const MaterialParam &param = entry.second;
    if (param.ok) {
      params.push_back(param.param);
      if (param.param.has_tex) {
        wire.textures.push_back(param.param.tex);
      }
    } else if (!wire.unsupported) {
      wire.unsupported = true;
      wire.reason = param.reason;
    }
  }
  wire.params = std::move(params);
  wire.version = material.version;
  return wire;
}

bool Mirror::to_param(const std::string &name, const DecodedParam &value, Param *out,
                      MaterialReason *reason) const {
  out->name = name;
  if (value.status != "ok") {
    *reason = value.reason == "param-range" ? MaterialReason::ParamRange : MaterialReason::ParamType;
    return false;
  }
  VariantType type;
  if (!variant_type_of(value, &type)) {
    *reason = MaterialReason::ParamType;
    return false;
  }
  out->type = type;
  out->n = static_cast<std::int32_t>(value.n);
  out->has_tex = false;
  out->tex = 0;
  out->floats.clear();
  if (type == VariantType::Rid) {
    out->n = 1;
    const auto it = texture_by_rid_.find(value.tex_rid);
    if (value.tex_rid == 0 || it == texture_by_rid_.end()) {
      *reason = MaterialReason::UnknownTexture;
      return false;
    }
    out->has_tex = true;
    out->tex = it->second;
    return true;
  }
  if (type == VariantType::Nil) {
    out->n = 1;
    return true;
  }
  const std::size_t want =
      static_cast<std::size_t>(value.n) * static_cast<std::size_t>(variant_components(type));
  if (value.f.size() != want) {
    *reason = MaterialReason::ParamType;
    return false;
  }
  out->floats = value.f;
  return true;
}

std::uint32_t Mirror::effective_material(const Item &item) const {
  // D9 (renderer_canvas_cull.cpp:2514-2525): own material, or the item parent's while
  // use_parent_material chains up; a top-level item keeps its own.
  std::uint32_t material = item.state.has_material ? item.state.material : 0;
  if (!item.state.use_parent_material) {
    return material;
  }
  ParentRef parent = item.state.parent;
  std::size_t guard = 0;
  while (parent.kind == ParentKind::Item && guard++ < items_.size()) {
    const auto it = items_.find(parent.id);
    if (it == items_.end()) {
      break;
    }
    const ItemState &p = it->second.state;
    material = p.has_material ? p.material : 0;
    if (!p.use_parent_material) {
      break;
    }
    parent = p.parent;
  }
  return material;
}

bool Mirror::material_unsupported(std::uint32_t material_id) const {
  const auto it = materials_.find(material_id);
  if (it == materials_.end()) {
    return false;
  }
  const Material &material = it->second;
  const auto texture_unsupported = [this](std::uint32_t tex) {
    const auto t = textures_.find(tex);
    return t != textures_.end() &&
           (t->second.status == TextureStatus::Unsupported || pending_ids_.count(tex) != 0);
  };
  // P3-CAP: wire_material()'s status without building the entry (the same two conditions).
  const Material::WireParams &wire = wire_params(material);
  if (material.shader_unknown || wire.unsupported) {
    return true;
  }
  for (std::uint32_t tex : wire.textures) {
    if (texture_unsupported(tex)) {
      return true;
    }
  }
  if (material.has_shader) {
    const auto s = shaders_.find(material.shader);
    if (s != shaders_.end()) {
      if (wire_shader(s->second).status == ShaderStatus::Unsupported ||
          !s->second.unresolvable_defaults.empty()) {
        return true;
      }
      for (const auto &entry : s->second.default_textures) {
        if (texture_unsupported(entry.second)) {
          return true;
        }
      }
    }
  }
  return false;
}

void Mirror::shader_create(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || dropped_identity("shader_create", frame)) {
    return;
  }
  Shader shader;
  shader.id = next_shader_id_++;
  shader.rid = rid;
  shader_by_rid_[rid] = shader.id;
  shaders_.emplace(shader.id, std::move(shader));
}

void Mirror::shader_create_from_code(std::uint64_t rid, const ShaderCodeInput &code,
                                     std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || dropped_identity("shader_create_from_code", frame)) {
    return;
  }
  Shader shader;
  shader.id = next_shader_id_++;
  shader.rid = rid;
  take_shader_code(&shader, code, frame);
  shader_by_rid_[rid] = shader.id;
  shaders_.emplace(shader.id, std::move(shader));
}

void Mirror::shader_set_code(std::uint64_t rid, const ShaderCodeInput &code, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped_identity("shader_set_code", frame)) {
    return;
  }
  Shader *shader = find_shader(rid);
  if (shader == nullptr) {
    ++stats_.material_unknown;
    return;
  }
  take_shader_code(shader, code, frame);
  ++shader->version;
}

void Mirror::shader_set_default_texture_parameter(std::uint64_t rid, const std::string &name,
                                                  std::uint64_t texture, std::int32_t index,
                                                  std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped_identity("shader_set_default_texture_parameter", frame)) {
    return;
  }
  Shader *shader = find_shader(rid);
  if (shader == nullptr) {
    ++stats_.material_unknown;
    return;
  }
  const auto key = std::make_pair(name, index);
  shader->default_textures.erase(key);
  shader->unresolvable_defaults.erase(key);
  if (texture != 0) {
    const auto it = texture_by_rid_.find(texture);
    if (it != texture_by_rid_.end()) {
      shader->default_textures[key] = it->second;
    } else {
      shader->unresolvable_defaults.insert(key);
    }
  }
  ++shader->version;
}

void Mirror::material_create(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || dropped_identity("material_create", frame)) {
    return;
  }
  Material material;
  material.id = next_material_id_++;
  material.rid = rid;
  material_by_rid_[rid] = material.id;
  materials_.emplace(material.id, std::move(material));
}

void Mirror::material_create_from_shader(std::uint64_t rid, std::uint64_t shader,
                                         std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0 || dropped_identity("material_create_from_shader", frame)) {
    return;
  }
  Material material;
  material.id = next_material_id_++;
  material.rid = rid;
  if (shader != 0) {
    const auto it = shader_by_rid_.find(shader);
    if (it != shader_by_rid_.end()) {
      material.has_shader = true;
      material.shader = it->second;
    } else {
      material.shader_unknown = true;
      material.unknown_shader_rid = shader;
      ++material_refs_epoch_;
    }
  }
  material_by_rid_[rid] = material.id;
  materials_.emplace(material.id, std::move(material));
}

void Mirror::material_set_shader(std::uint64_t rid, std::uint64_t shader, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped_identity("material_set_shader", frame)) {
    return;
  }
  Material *material = find_material(rid);
  if (material == nullptr) {
    ++stats_.material_unknown;
    return;
  }
  material->has_shader = false;
  material->shader = 0;
  material->shader_unknown = false;
  material->unknown_shader_rid = 0;
  if (shader != 0) {
    const auto it = shader_by_rid_.find(shader);
    if (it != shader_by_rid_.end()) {
      material->has_shader = true;
      material->shader = it->second;
    } else {
      material->shader_unknown = true;
      material->unknown_shader_rid = shader;
      ++material_refs_epoch_;
    }
  }
  ++material->version;
}

void Mirror::material_set_param(std::uint64_t rid, const std::string &name,
                                const DecodedParam &value, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped_identity("material_set_param", frame)) {
    return;
  }
  Material *material = find_material(rid);
  if (material == nullptr) {
    ++stats_.material_unknown;
    return;
  }
  if (value.type == "object") {
    return;  // D6: GLES3 rejects an OBJECT value (g3ms.cpp:2463); no change, no version
  }
  if (!value.packed && (value.type == "nil" || (value.type == "rid" && value.status == "ok" &&
                                                value.tex_rid == 0))) {
    // D6: NIL erases (g3ms.cpp:2460-2461). RID() is erased too: GLES3 then falls back to the
    // shader's default texture exactly as for an unset sampler (g3ms.cpp:2302-2326).
    material->params.erase(name);
    ++material->version;
    return;
  }
  MaterialParam param;
  param.ok = to_param(name, value, &param.param, &param.reason);
  material->params[name] = std::move(param);
  ++material->version;
}

void Mirror::set_material(std::uint64_t rid, std::uint64_t material, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_material", frame)) {
    return;
  }
  Item *item = item_for(rid, "canvas_item_set_material", frame);
  if (item == nullptr) {
    return;
  }
  // D9: item state, never content_version (ci.cpp:1169-1177).
  item->state.has_material = false;
  item->state.material = 0;
  item->unknown_material = false;
  item->unknown_material_rid = 0;
  if (material != 0) {
    // G8m: any assignment may give a material with an unknown shader its first item.
    ++material_refs_epoch_;
    const auto it = material_by_rid_.find(material);
    if (it != material_by_rid_.end()) {
      item->state.has_material = true;
      item->state.material = it->second;
    } else {
      item->unknown_material = true;
      item->unknown_material_rid = material;
    }
  }
}

void Mirror::set_use_parent_material(std::uint64_t rid, bool enable, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_use_parent_material", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_use_parent_material", frame)) {
    item->state.use_parent_material = enable;
  }
}

void Mirror::set_instance_shader_parameter(std::uint64_t rid, const std::string &name,
                                           const DecodedParam &value, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_instance_shader_parameter", frame)) {
    return;
  }
  Item *item = item_for(rid, "canvas_item_set_instance_shader_parameter", frame);
  if (item == nullptr) {
    return;
  }
  if (value.type == "object") {
    return;  // iu.cpp:112: an OBJECT is rejected
  }
  Param param;
  MaterialReason reason;
  item->instance_params.erase(name);
  item->instance_param_unsupported.erase(name);
  // Q3b: NIL is kept as type nil and replayed as such (the server then restores its default).
  // A rid names the texture table like a material parameter; an unresolvable one is a param-type
  // entry (the wire has no instance-level unknown-texture reason).
  if (to_param(name, value, &param, &reason)) {
    item->instance_params[name] = std::move(param);
  } else {
    item->instance_param_unsupported.insert(name);
  }
  item->state.instance_params.clear();
  for (const auto &entry : item->instance_params) {
    item->state.instance_params.push_back(entry.second);
  }
}

void Mirror::canvas_set_modulate(std::uint64_t canvas, const Color4 &color, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_set_modulate";
  if (dropped(kOp, frame)) {
    return;
  }
  const auto it = canvas_by_rid_.find(canvas);
  if (it == canvas_by_rid_.end()) {
    unknown(canvas, kOp, frame);
    return;
  }
  canvases_.at(it->second).state.modulate = color;
}

void Mirror::canvas_light_attach_to_canvas(std::uint64_t light, std::uint64_t canvas,
                                           std::uint64_t frame) {
  (void)light;
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_light_attach_to_canvas";
  if (dropped(kOp, frame)) {
    return;
  }
  if (canvas != 0) {
    session_unsupported(kOp, UnsupportedReason::CanvasLight);  // D10: sticky
  }
}

// --- publication ----------------------------------------------------------------

void Mirror::find_ties(const std::vector<std::uint32_t> &children,
                       std::vector<UnsupportedRef> *out) const {
  // render-stream-1.md "Invariant 9": group the container's children by
  // draw_index; a group with at least two *drawing* members (non-empty
  // commands or non-empty children) gets exactly one entry, at the smallest
  // drawing id. The engine's order among equal indices depends on its sort
  // history (gate1-design.md Q2c, D7), which a receiver cannot reproduce.
  if (children.size() < 2) {
    return;  // P3-CAP: a tie needs two members
  }
  // P3-CAP: (draw_index, id) of the drawing children, sorted: a run of one index is a group, its
  // first id the smallest -- the entries a std::map<index, (count, min id)> gave, in index order.
  std::vector<std::pair<std::int32_t, std::uint32_t>> drawing;
  drawing.reserve(children.size());
  for (std::uint32_t child : children) {
    const auto it = items_.find(child);
    if (it == items_.end()) {
      continue;
    }
    const ItemState &state = it->second.state;
    if (state.commands.empty() && state.children.empty()) {
      continue;  // not drawing
    }
    drawing.emplace_back(state.draw_index, state.id);
  }
  std::sort(drawing.begin(), drawing.end());
  for (std::size_t i = 0; i < drawing.size();) {
    std::size_t end = i + 1;
    while (end < drawing.size() && drawing[end].first == drawing[i].first) {
      ++end;
    }
    if (end - i >= 2) {
      UnsupportedRef ref;
      ref.op = "canvas_item_set_draw_index";
      ref.has_item = true;
      ref.item = drawing[i].second;
      ref.reason = UnsupportedReason::DrawIndexTie;
      out->push_back(std::move(ref));
    }
    i = end;
  }
}

Captured Mirror::snapshot(std::uint64_t seq, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Captured captured;
  Snapshot &out = captured.state;
  // G55d (gate5_5-design.md D1): the capture speaks render-stream/5; the stamp makes make_full /
  // make_patch carry the shader and material tables, the item material fields, the canvas
  // modulate and param_f64 (memory rs-g5d-rs4-switch-facts: Session V5 alone is not enough), on
  // top of /4's mesh table and cmd_i32 / mesh_f32 blocks.
  // G6b (gate6-design.md D1): render-stream/6 -- canvases carry layer/sublayer and the /6
  // session-level reasons; every table above is /5's.
  out.version = ProtocolVersion::V6;
  out.seq = seq;
  out.frame = frame;
  out.failures = failures_;
  out.default_texture_filter = default_filter_;
  out.default_texture_repeat = default_repeat_;

  // G8kf: the textures this snapshot carries as `delivery-pending` (see below). Decided first,
  // because an item naming one needs its derived unsupported-texture entry like any unsupported
  // texture (render-stream-2.md "Item-level unsupported entries").
  std::set<std::uint32_t> &pending_ids = pending_ids_;
  pending_ids.clear();
  std::set<std::uint32_t> referenced;  // the tombstone rule's texture references (see below)
  for (auto &entry : textures_) {
    Texture &texture = entry.second;
    if (texture.kind == TextureKind::Canvas && texture.has_diffuse) {
      referenced.insert(texture.diffuse_id);  // G2d: a diffuse keeps its target's tombstone alive
    }
    settle(&texture);
    if (resolve_pending(&texture)) {
      ++epoch_;  // the version moved under a snapshot taken before service_pending ran
    }
    if (publish_pending_ && texture.job != nullptr && texture.kind == TextureKind::Image &&
        texture.status == TextureStatus::Ok && !texture.published_ok) {
      pending_ids.insert(entry.first);
    }
  }

  // protocol/unknown-item-skip.md: under Skip, every known item whose parent chain reaches an
  // unknown RID is left out of the published state -- its item entry, its item-level unsupported
  // entries and its draw-index groups. No published container lists one (a withheld item's parent
  // is unknown or withheld itself), so canvases and the remaining items need no filtering. The
  // texture table is not filtered: a tombstone a withheld command names stays, as under Strict.
  const std::set<std::uint32_t> withheld = withheld_ids();
  if (skip_unknown()) {
    UnknownItems &unknown = out.unknown_items;
    unknown.present = true;
    unknown.unknown_rids = unknown_rids_.size();
    unknown.withheld_items = withheld.size();
    for (std::uint32_t id : withheld) {
      unknown.withheld_commands += items_.at(id).state.commands.size();
    }
    unknown.unknown_calls = stats_.unknown_calls;
  }

  // Session-level entries first: degenerate-host-size (observed at session
  // start, so always the first one -- render-stream-1.md "Unsupported
  // reasons"), then the others in first-observed order (render-stream-0.md
  // "Transaction").
  if (degenerate_host_size_) {
    UnsupportedRef ref;
    ref.op = "root_viewport_size";
    ref.has_item = false;
    ref.reason = UnsupportedReason::DegenerateHostSize;
    out.unsupported.push_back(std::move(ref));
  }
  // G6b (render-stream-6.md "Session-level unsupported reasons"): snap-2d is an arm-time
  // constant, so it is observed at session start, right after degenerate-host-size. One entry,
  // named after the transforms setter when that flag is set, else the vertices setter.
  if (snap_transforms_ || snap_vertices_) {
    UnsupportedRef ref;
    ref.op = snap_transforms_ ? "viewport_set_snap_2d_transforms_to_pixel"
                              : "viewport_set_snap_2d_vertices_to_pixel";
    ref.has_item = false;
    ref.reason = UnsupportedReason::Snap2d;
    out.unsupported.push_back(std::move(ref));
  }
  out.unsupported.insert(out.unsupported.end(), session_unsupported_.begin(),
                         session_unsupported_.end());
  // The two per-snapshot conditions follow the sticky entries: the global canvas transform
  // while it differs bitwise from the arm-time reference, then a stacking tie between two
  // attached canvases (the renderer would order them by RID, rv.h:125-130).
  if (std::memcmp(global_current_.data(), global_reference_.data(),
                  sizeof(float) * global_current_.size()) != 0) {
    UnsupportedRef ref;
    ref.op = "viewport_set_global_canvas_transform";
    ref.has_item = false;
    ref.reason = UnsupportedReason::GlobalCanvasTransform;
    out.unsupported.push_back(std::move(ref));
  }
  {
    std::set<std::pair<std::int32_t, std::int32_t>> keys;
    bool tie = false;
    for (const auto &entry : canvases_) {
      const CanvasState &state = entry.second.state;
      if (!state.attached) {
        continue;
      }
      if (!keys.insert({state.layer, state.sublayer}).second) {
        tie = true;
        break;
      }
    }
    if (tie) {
      UnsupportedRef ref;
      ref.op = "viewport_set_canvas_stacking";
      ref.has_item = false;
      ref.reason = UnsupportedReason::CanvasStackingTie;
      out.unsupported.push_back(std::move(ref));
    }
  }

  // A tombstone leaves the table at the first snapshot in which nothing names it
  // (gate2-design.md Q3). `referenced` gathers every texture id something names: the items'
  // commands and rid instance parameters (in the items walk below), a canvas texture's diffuse
  // (G2d, gathered in the first textures walk above), material rid parameters and shader default
  // textures (G55d); `meshes_named` every mesh an add_mesh names (G5e).
  //
  // P3-CAP: one walk of the items does the tombstone references, the item-level entries and the
  // published items. Nothing the item-level entries look up is a tombstone removed below (a
  // removed tombstone is named by nothing), so building them first changes no entry.
  std::set<std::uint32_t> meshes_named;
  // Item-level entries (render-stream-2.md "Item-level unsupported entries"): one per distinct
  // (op, reason) pair of each item -- an unsupported command's name and reason, a texture draw
  // naming an unsupported texture (unsupported-texture), a material (unsupported-state) -- and
  // draw-index-tie per container; then ordered by item id, then op, then reason (byte order).
  std::vector<UnsupportedRef> item_level;
  std::map<std::uint32_t, bool> material_unsupported_memo;
  // P3-CAP: an item's own entries are the ones added since its walk began (find_ties adds only
  // draw-index-tie, which add_item_entry never adds), so the distinct-pair check scans just those.
  std::size_t item_begin = 0;
  const auto add_item_entry = [&item_level, &item_begin](std::uint32_t item, const std::string &op,
                                                         UnsupportedReason reason) {
    for (std::size_t i = item_begin; i < item_level.size(); ++i) {
      const UnsupportedRef &ref = item_level[i];
      if (ref.has_item && ref.item == item && ref.op == op && ref.reason == reason) {
        return;
      }
    }
    UnsupportedRef ref;
    ref.op = op;
    ref.has_item = true;
    ref.item = item;
    ref.reason = reason;
    item_level.push_back(std::move(ref));
  };
  out.items.reserve(items_.size() - withheld.size());
  for (auto &entry : items_) {
    for (const Command &command : entry.second.state.commands) {
      if (names_texture(command) && command.has_tex) {
        referenced.insert(command.tex);
      }
      if (command.kind == CommandKind::AddMesh) {
        meshes_named.insert(command.mesh);
      }
    }
    for (const auto &param : entry.second.instance_params) {
      if (param.second.has_tex) {
        referenced.insert(param.second.tex);
      }
    }
    if (withheld.count(entry.first) != 0) {
      continue;
    }
    item_begin = item_level.size();
    const Item &item = entry.second;
    const ItemState &state = item.state;
    for (const Command &command : state.commands) {
      if (command.kind == CommandKind::Unsupported) {
        UnsupportedReason reason = UnsupportedReason::UnsupportedOp;
        if (command.unsupported_reason == UnsupportedCmdReason::UnknownTexture) {
          reason = UnsupportedReason::UnknownTexture;
        } else if (command.unsupported_reason == UnsupportedCmdReason::CanvasTextureHeadless) {
          reason = UnsupportedReason::CanvasTextureHeadless;
        } else if (command.unsupported_reason == UnsupportedCmdReason::SkinnedGeometry) {
          reason = UnsupportedReason::SkinnedGeometry;  // render-stream-4.md, D16
        } else if (command.unsupported_reason == UnsupportedCmdReason::UnknownMesh) {
          reason = UnsupportedReason::UnknownMesh;
        }
        add_item_entry(state.id, command.name, reason);
      } else if (names_texture(command) && command.has_tex) {
        // render-stream-2.md "Item-level unsupported entries": the command's own tex is
        // unsupported, or (G2d) it names a canvas entry whose diffuse names one.
        const auto texture = textures_.find(command.tex);
        bool unsupported_ref =
            texture != textures_.end() && (texture->second.status == TextureStatus::Unsupported ||
                                           pending_ids.count(command.tex) != 0);
        if (!unsupported_ref && texture != textures_.end() &&
            texture->second.kind == TextureKind::Canvas && texture->second.has_diffuse) {
          const auto diffuse = textures_.find(texture->second.diffuse_id);
          unsupported_ref =
              diffuse != textures_.end() && (diffuse->second.status == TextureStatus::Unsupported ||
                                             pending_ids.count(texture->second.diffuse_id) != 0);
        }
        if (unsupported_ref) {
          add_item_entry(state.id, rs_method_name(command.kind),
                         UnsupportedReason::UnsupportedTexture);
        }
      }
      if (command.kind == CommandKind::AddMesh) {
        // render-stream-4.md "Command": an add_mesh naming an `unsupported` mesh entry.
        const auto mesh = meshes_.find(command.mesh);
        if (mesh != meshes_.end() && mesh->second.status == MeshStatus::Unsupported) {
          add_item_entry(state.id, "canvas_item_add_mesh", UnsupportedReason::UnsupportedMesh);
        }
      }
    }
    // G55d (render-stream-5.md "Derived item-level entries"): at most one canvas_item_set_material
    // entry per item -- an unknown material RID, else an unsupported effective material (D9) --
    // and one canvas_item_set_instance_shader_parameter param-type entry.
    if (item.unknown_material) {
      add_item_entry(state.id, "canvas_item_set_material", UnsupportedReason::UnknownMaterial);
    } else {
      const std::uint32_t effective = effective_material(item);
      if (effective != 0) {
        // P3-CAP: once per material per snapshot (nothing it reads changes under the lock).
        auto memo = material_unsupported_memo.find(effective);
        if (memo == material_unsupported_memo.end()) {
          memo = material_unsupported_memo.emplace(effective, material_unsupported(effective)).first;
        }
        if (memo->second) {
          add_item_entry(state.id, "canvas_item_set_material",
                         UnsupportedReason::UnsupportedMaterial);
        }
      }
    }
    if (!item.instance_param_unsupported.empty()) {
      add_item_entry(state.id, "canvas_item_set_instance_shader_parameter",
                     UnsupportedReason::ParamType);
    }
    if (item.unsupported_skeleton) {
      add_item_entry(state.id, "canvas_item_attach_skeleton", UnsupportedReason::UnsupportedState);
    }
    find_ties(state.children, &item_level);
    entry.second.published = true;
    out.items.push_back(state);
  }
  for (const auto &entry : canvases_) {
    find_ties(entry.second.state.items, &item_level);
  }
  for (const auto &entry : materials_) {
    for (std::uint32_t tex : wire_params(entry.second).textures) {
      referenced.insert(tex);
    }
  }
  for (const auto &entry : shaders_) {
    for (const auto &ref : entry.second.default_textures) {
      referenced.insert(ref.second);
    }
  }
  for (auto it = textures_.begin(); it != textures_.end();) {
    if (it->second.status == TextureStatus::Freed && referenced.count(it->first) == 0) {
      it = textures_.erase(it);
    } else {
      ++it;
    }
  }
  // G5e: likewise a mesh tombstone leaves at the first snapshot no add_mesh names it.
  for (auto it = meshes_.begin(); it != meshes_.end();) {
    if (it->second.status == MeshStatus::Freed && meshes_named.count(it->first) == 0) {
      it = meshes_.erase(it);
    } else {
      ++it;
    }
  }
  std::sort(item_level.begin(), item_level.end(),
            [](const UnsupportedRef &a, const UnsupportedRef &b) {
              if (a.item != b.item) {
                return a.item < b.item;
              }
              if (a.op != b.op) {
                return a.op < b.op;
              }
              return std::string(to_wire(a.reason)) < std::string(to_wire(b.reason));
            });
  out.unsupported.insert(out.unsupported.end(), std::make_move_iterator(item_level.begin()),
                         std::make_move_iterator(item_level.end()));

  out.canvases.reserve(canvases_.size());
  for (const auto &entry : canvases_) {
    out.canvases.push_back(entry.second.state);
  }
  out.textures.reserve(textures_.size());
  for (auto &entry : textures_) {
    Texture &texture = entry.second;
    settle(&texture);  // G8kw: a finished worker's hash and bytes, before they are published
    if (pending_ids.count(entry.first) != 0) {
      // G8kf: not ready, and never published as ok: carry it as `delivery-pending` (the shape the
      // hook already knows, no hash, no payload) and do not hold the snapshot back for it.
      Texture shown = texture;
      shown.status = TextureStatus::Unsupported;
      shown.has_reason = true;
      shown.reason = TextureReason::DeliveryPending;
      out.textures.push_back(wire_entry(shown));
      if (texture.pending_version != texture.version) {
        ++pending_published_;  // textures, not snapshots
      }
      texture.pending_version = texture.version;
      continue;
    }
    if (texture.kind == TextureKind::Image && texture.status == TextureStatus::Ok &&
        texture.job == nullptr) {
      texture.published_ok = true;
    }
    out.textures.push_back(wire_entry(texture));
    if (texture.kind == TextureKind::Image && texture.status == TextureStatus::Ok &&
        texture.bytes != nullptr) {
      captured.payloads.emplace(texture.copy.hash, texture.bytes);
      // G8kp: every variant the entry lists travels in the same content-addressed map (store,
      // HTTP), never as an inline record (rs_captured.h variant_refs).
      for (const rs2::TextureVariant &variant : out.textures.back().variants) {
        if (variant.hash == texture.copy.block_hash && texture.copy.block_bytes != nullptr) {
          captured.payloads.emplace(variant.hash, texture.copy.block_bytes);
        } else if (variant.hash == texture.uastc_hash && texture.uastc_bytes != nullptr) {
          captured.payloads.emplace(variant.hash, texture.uastc_bytes);  // G8ku: a KTX2
        }
      }
    } else if (texture.job != nullptr && texture.kind == TextureKind::Image &&
               texture.status == TextureStatus::Ok) {
      // G8kw: still on a worker. The entry is complete but for its hash; the caller holds the
      // snapshot back until resolve_captured() can fill it (rs_texture_worker.h).
      PendingTexture pending;
      pending.index = out.textures.size() - 1;
      pending.job = texture.job;
      captured.pending.push_back(std::move(pending));
    }
  }
  out.meshes.reserve(meshes_.size());
  for (const auto &entry : meshes_) {
    const Mesh &mesh = entry.second;
    out.meshes.push_back(wire_mesh(mesh));
    if (mesh.status != MeshStatus::Ok) {
      continue;
    }
    for (const MeshSurf &surface : mesh.surfaces) {
      if (surface.bytes != nullptr) {
        captured.payloads.emplace(surface.hash, surface.bytes);
      }
    }
  }
  // G55d: the shader and material tables (sorted by id); the payload of every `ok` shader whose
  // code travels (`source: "payload"`: never a withheld one, D4) -- exactly payload_refs' set.
  out.shaders.reserve(shaders_.size());
  for (const auto &entry : shaders_) {
    const Shader &shader = entry.second;
    ShaderEntry wire = wire_shader(shader);
    if (wire.status == ShaderStatus::Ok && wire.has_source &&
        wire.source == ShaderSource::Payload && wire.has_hash && shader.bytes != nullptr) {
      captured.payloads.emplace(wire.hash, shader.bytes);
    }
    out.shaders.push_back(std::move(wire));
  }
  out.materials.reserve(materials_.size());
  for (const auto &entry : materials_) {
    out.materials.push_back(wire_material(entry.second));
  }
  return captured;
}

MirrorStats Mirror::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  MirrorStats out = stats_;
  out.live_canvases = canvases_.size();
  out.live_items = items_.size();
  out.live_textures = textures_.size();
  out.unknown_rids = unknown_rids_.size();
  out.withheld_items = withheld_ids().size();
  std::set<std::string> hashes;
  for (const auto &entry : textures_) {
    const Texture &texture = entry.second;
    if (texture.bytes != nullptr && hashes.insert(texture.copy.hash).second) {
      out.texture_payload_bytes += texture.bytes->size();
    } else if (texture.job != nullptr && texture.job->done() && texture.job->bytes() != nullptr &&
               hashes.insert(texture.job->actual().hash).second) {
      out.texture_payload_bytes += texture.job->bytes()->size();  // G8kw: finished, not settled
    }
  }
  out.live_shaders = shaders_.size();
  out.live_materials = materials_.size();
  std::set<std::string> shader_hashes;
  for (const auto &entry : shaders_) {
    const Shader &shader = entry.second;
    if (shader.bytes != nullptr && shader_hashes.insert(shader.copy.hash).second) {
      out.shader_payload_bytes += shader.bytes->size();
    }
  }
  out.live_meshes = meshes_.size();
  std::set<std::string> mesh_hashes;
  for (const auto &entry : meshes_) {
    for (const MeshSurf &surface : entry.second.surfaces) {
      if (surface.bytes != nullptr && mesh_hashes.insert(surface.hash).second) {
        out.mesh_payload_bytes += surface.bytes->size();
      }
    }
  }
  return out;
}

// --- process-wide mirror ----------------------------------------------------------

namespace {

std::atomic<bool> g_enabled{false};

}  // namespace

Mirror &mirror_instance() {
  static Mirror mirror;
  return mirror;
}

void mirror_enable(bool enabled) {
  const bool was = g_enabled.exchange(enabled);
  if (enabled && !was) {
    mirror_instance().reset();
  }
}

bool mirror_enabled() { return g_enabled.load(std::memory_order_acquire); }

void mirror_set_root(std::uint64_t viewport_rid, std::uint64_t canvas_rid, const Xform &xform) {
  mirror_instance().set_root(viewport_rid, canvas_rid, xform);
}

void mirror_fail_root_query(const std::string &detail) {
  mirror_instance().fail_root_query(detail);
}

void mirror_fail_root_size_enforce(const std::string &detail) {
  mirror_instance().fail_root_size_enforce(detail);
}

void mirror_set_degenerate_host_size(bool on) { mirror_instance().set_degenerate_host_size(on); }
void mirror_set_canvas_texture_headless(bool on) {
  mirror_instance().set_canvas_texture_headless(on);
}

void mirror_set_unknown_item_policy(UnknownItemPolicy policy) {
  mirror_instance().set_unknown_item_policy(policy);
}

void mirror_set_caps(std::size_t max_items, std::size_t max_commands) {
  mirror_instance().set_caps(max_items, max_commands);
}

void mirror_set_drop_frame(std::uint64_t frame) { mirror_instance().set_drop_frame(frame); }

void mirror_set_omit_op(const std::string &op, std::uint64_t from_frame) {
  mirror_instance().set_omit_op(op, from_frame);
}

void mirror_set_perturb_vertex(std::uint64_t from_frame) {
  mirror_instance().set_perturb_vertex(from_frame);
}

void mirror_set_perturb_shader(std::uint64_t from_frame) {
  mirror_instance().set_perturb_shader(from_frame);
}

void mirror_set_shader_policy(ShaderPolicy policy) { mirror_instance().set_shader_policy(policy); }

void mirror_set_perturb_glyph(std::uint64_t from_frame) {
  mirror_instance().set_perturb_glyph(from_frame);
}

std::uint64_t mirror_epoch() { return mirror_instance().epoch(); }

Captured mirror_snapshot(std::uint64_t seq, std::uint64_t frame) {
  return mirror_instance().snapshot(seq, frame);
}

MirrorStats mirror_stats() { return mirror_instance().stats(); }

}  // namespace rs
}  // namespace grc
