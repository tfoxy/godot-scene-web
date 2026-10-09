#include "rs0_mirror.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <utility>

namespace grc {
namespace rs0 {

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
  drop_frame_ = 0;
  next_canvas_id_ = kRootCanvasId + 1;
  next_item_id_ = 1;
  root_viewport_rid_ = 0;
  canvases_.clear();
  items_.clear();
  canvas_by_rid_.clear();
  item_by_rid_.clear();
  untracked_items_.clear();
  failures_.clear();
  session_unsupported_.clear();
  stats_ = MirrorStats();

  // Canvas 1 always exists, so every snapshot has its root canvas
  // (render-stream-0.md invariant `root-canvas`), even when the root query
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
  fail(FailureReason::RootQueryFailed, detail);
}

void Mirror::set_drop_frame(std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  drop_frame_ = frame;
}

// --- helpers (mutex_ held) ----------------------------------------------------

bool Mirror::dropped(std::uint64_t frame) {
  if (drop_frame_ != 0 && frame == drop_frame_) {
    ++stats_.dropped_omit_update;
    return true;
  }
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
}

// --- identity -------------------------------------------------------------------

void Mirror::canvas_create(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0) {
    return;
  }
  if (canvases_.size() >= kMaxLiveItems) {
    ++stats_.dropped_capacity;
    fail(FailureReason::MirrorCapacity,
         "live canvases > " + u64(kMaxLiveItems) + " rid=" + u64(rid) + " frame=" + u64(frame));
    return;
  }
  Canvas canvas;
  canvas.rid = rid;
  canvas.state.id = next_canvas_id_++;
  canvas.state.origin = Origin::Created;
  canvas.state.role = CanvasRole::None;
  canvas.state.attached = false;
  canvas_by_rid_[rid] = canvas.state.id;
  canvases_.emplace(canvas.state.id, std::move(canvas));
}

void Mirror::canvas_item_create(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (rid == 0) {
    return;
  }
  if (items_.size() >= kMaxLiveItems) {
    ++stats_.dropped_capacity;
    untracked_items_.insert(rid);
    fail(FailureReason::MirrorCapacity,
         "live items > " + u64(kMaxLiveItems) + " rid=" + u64(rid) + " frame=" + u64(frame));
    return;
  }
  Item item;
  item.rid = rid;
  item.state.id = next_item_id_++;
  item.state.origin = Origin::Created;
  item_by_rid_[rid] = item.state.id;
  items_.emplace(item.state.id, std::move(item));
}

void Mirror::free_rid(std::uint64_t rid, std::uint64_t /*frame*/) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (Item *item = find_item(rid)) {
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
  if (untracked_items_.erase(rid) != 0) {
    return;
  }
  ++stats_.free_unknown;  // textures, meshes, materials, ... share this slot
}

// --- viewport -------------------------------------------------------------------

void Mirror::viewport_attach_canvas(std::uint64_t viewport, std::uint64_t canvas,
                                    std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  static const char kOp[] = "viewport_attach_canvas";
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
  if (target.state.id != kRootCanvasId) {
    session_unsupported(kOp, UnsupportedReason::ExtraCanvas);
  }
}

void Mirror::viewport_set_canvas_transform(std::uint64_t viewport, std::uint64_t canvas,
                                           const Xform &xform, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  static const char kOp[] = "viewport_set_canvas_transform";
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
  if (dropped(frame)) {
    return;
  }
  static const char kOp[] = "canvas_item_set_parent";
  Item *item = item_for(item_rid, kOp, frame);
  if (item == nullptr) {
    return;
  }
  ParentRef parent;
  if (parent_rid != 0) {
    Target target;
    if (!find_target(parent_rid, &target)) {
      if (untracked_items_.count(parent_rid) != 0) {
        ++stats_.ignored_untracked;
      } else {
        unknown(parent_rid, kOp, frame);
      }
      return;
    }
    parent.kind = target.kind == Kind::Canvas ? ParentKind::Canvas : ParentKind::Item;
    parent.id = target.id;
  }
  // renderer_canvas_cull.cpp:569-598: remove from the old parent's list, then
  // append to the new one -- even when the parent is unchanged.
  detach(item);
  if (parent.kind != ParentKind::None) {
    std::vector<std::uint32_t> *list = children_of(parent.kind, parent.id);
    if (list != nullptr) {
      list->push_back(item->state.id);
      item->state.parent = parent;
    }
  }
}

void Mirror::set_transform(std::uint64_t rid, const Xform &xform, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_transform", frame)) {
    item->state.xform = xform;
  }
}

void Mirror::set_modulate(std::uint64_t rid, const Color4 &color, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_modulate", frame)) {
    item->state.modulate = color;
  }
}

void Mirror::set_self_modulate(std::uint64_t rid, const Color4 &color, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_self_modulate", frame)) {
    item->state.self_modulate = color;
  }
}

void Mirror::set_visible(std::uint64_t rid, bool visible, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_visible", frame)) {
    item->state.visible = visible;
  }
}

void Mirror::set_clip(std::uint64_t rid, bool clip, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_clip", frame)) {
    item->state.clip = clip;
  }
}

void Mirror::set_custom_rect(std::uint64_t rid, bool enabled, const Rect4 &rect,
                             std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_custom_rect", frame)) {
    item->state.custom_rect = enabled;
    item->state.custom_rect_rect = rect;
  }
}

void Mirror::set_visibility_layer(std::uint64_t rid, std::uint32_t layer, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_visibility_layer", frame)) {
    item->state.visibility_layer = layer;
  }
}

void Mirror::set_z_index(std::uint64_t rid, std::int32_t z, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_z_index", frame)) {
    item->state.z_index = z;
  }
}

void Mirror::set_draw_index(std::uint64_t rid, std::int32_t index, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_draw_index", frame)) {
    item->state.draw_index = index;
  }
}

void Mirror::set_material(std::uint64_t rid, std::uint64_t material, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_material", frame)) {
    item->state.unsupported_state = material != 0;
  }
}

void Mirror::clear(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_clear", frame)) {
    item->state.commands.clear();
    ++item->state.content_version;
  }
}

void Mirror::add_rect(std::uint64_t rid, const Rect4 &rect, const Color4 &color, bool antialiased,
                      std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  Item *item = item_for(rid, "canvas_item_add_rect", frame);
  if (item == nullptr) {
    return;
  }
  if (item->state.commands.size() >= kMaxCommandsPerItem) {
    ++stats_.dropped_capacity;
    fail(FailureReason::MirrorCapacity, "commands > " + u64(kMaxCommandsPerItem) +
                                            " item=" + u64(item->state.id) + " frame=" + u64(frame));
    return;
  }
  Command command;
  command.kind = CommandKind::AddRect;
  command.antialiased = antialiased;
  command.rect = rect;
  command.color = color;
  item->state.commands.push_back(std::move(command));
  ++item->state.content_version;
}

void Mirror::add_unsupported(std::uint64_t rid, const char *op, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped(frame)) {
    return;
  }
  Item *item = item_for(rid, op, frame);
  if (item == nullptr) {
    return;
  }
  if (item->state.commands.size() >= kMaxCommandsPerItem) {
    ++stats_.dropped_capacity;
    fail(FailureReason::MirrorCapacity, "commands > " + u64(kMaxCommandsPerItem) +
                                            " item=" + u64(item->state.id) + " frame=" + u64(frame));
    return;
  }
  Command command;
  command.kind = CommandKind::Unsupported;
  command.name = op;
  item->state.commands.push_back(std::move(command));
  ++item->state.content_version;
}

// --- publication ----------------------------------------------------------------

Snapshot Mirror::snapshot(std::uint64_t seq, std::uint64_t frame) const {
  std::lock_guard<std::mutex> lock(mutex_);
  Snapshot out;
  out.seq = seq;
  out.frame = frame;
  out.failures = failures_;

  // render-stream-0.md "Transaction": session-level entries in first-observed
  // order, then item-level entries by item id, then op (byte order).
  out.unsupported = session_unsupported_;
  for (const auto &entry : items_) {
    const ItemState &state = entry.second.state;
    std::vector<std::pair<std::string, UnsupportedReason>> own;
    for (const Command &command : state.commands) {
      if (command.kind != CommandKind::Unsupported) {
        continue;
      }
      const bool seen = std::any_of(own.begin(), own.end(),
                                    [&](const auto &pair) { return pair.first == command.name; });
      if (!seen) {
        own.emplace_back(command.name, UnsupportedReason::UnsupportedOp);
      }
    }
    if (state.unsupported_state) {
      own.emplace_back("canvas_item_set_material", UnsupportedReason::UnsupportedState);
    }
    std::sort(own.begin(), own.end(),
              [](const auto &a, const auto &b) { return a.first < b.first; });
    for (auto &pair : own) {
      UnsupportedRef ref;
      ref.op = std::move(pair.first);
      ref.has_item = true;
      ref.item = state.id;
      ref.reason = pair.second;
      out.unsupported.push_back(std::move(ref));
    }
  }

  out.canvases.reserve(canvases_.size());
  for (const auto &entry : canvases_) {
    out.canvases.push_back(entry.second.state);
  }
  out.items.reserve(items_.size());
  for (const auto &entry : items_) {
    out.items.push_back(entry.second.state);
  }
  return out;
}

MirrorStats Mirror::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  MirrorStats out = stats_;
  out.live_canvases = canvases_.size();
  out.live_items = items_.size();
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

void mirror_set_drop_frame(std::uint64_t frame) { mirror_instance().set_drop_frame(frame); }

Snapshot mirror_snapshot(std::uint64_t seq, std::uint64_t frame) {
  return mirror_instance().snapshot(seq, frame);
}

MirrorStats mirror_stats() { return mirror_instance().stats(); }

}  // namespace rs0
}  // namespace grc
