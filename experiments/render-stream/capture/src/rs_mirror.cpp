#include "rs_mirror.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <iterator>
#include <map>
#include <utility>

namespace grc {
namespace rs {

using namespace rs1;  // NOLINT: the wire types are the mirror's own types

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
  degenerate_host_size_ = false;
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

void Mirror::set_drop_frame(std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  drop_frame_ = frame;
}

void Mirror::set_omit_op(const std::string &op, std::uint64_t from_frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  omit_op_ = op;
  omit_from_frame_ = from_frame;
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
  if (rid == 0 || dropped_identity("canvas_create", frame)) {
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
  if (rid == 0 || dropped_identity("canvas_item_create", frame)) {
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
  if (untracked_items_.erase(rid) != 0) {
    ++epoch_;
    return;
  }
  ++stats_.free_unknown;  // textures, meshes, materials, ... share this slot
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
  if (target.state.id != kRootCanvasId) {
    session_unsupported(kOp, UnsupportedReason::ExtraCanvas);
  }
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

void Mirror::set_material(std::uint64_t rid, std::uint64_t material, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_material", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_material", frame)) {
    item->unsupported_state = material != 0;
  }
}

void Mirror::clear(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_clear", frame)) {
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
  if (dropped("canvas_item_add_rect", frame)) {
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
  if (dropped(op, frame)) {
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

void Mirror::find_ties(const std::vector<std::uint32_t> &children,
                       std::vector<UnsupportedRef> *out) const {
  // render-stream-1.md "Invariant 9": group the container's children by
  // draw_index; a group with at least two *drawing* members (non-empty
  // commands or non-empty children) gets exactly one entry, at the smallest
  // drawing id. The engine's order among equal indices depends on its sort
  // history (gate1-design.md Q2c, D7), which a receiver cannot reproduce.
  std::map<std::int32_t, std::pair<std::uint32_t, std::uint32_t>> groups;  // index -> (count, min id)
  for (std::uint32_t child : children) {
    const auto it = items_.find(child);
    if (it == items_.end()) {
      continue;
    }
    const ItemState &state = it->second.state;
    if (state.commands.empty() && state.children.empty()) {
      continue;  // not drawing
    }
    auto group = groups.find(state.draw_index);
    if (group == groups.end()) {
      groups.emplace(state.draw_index, std::make_pair(1u, state.id));
    } else {
      ++group->second.first;
      group->second.second = std::min(group->second.second, state.id);
    }
  }
  for (const auto &group : groups) {
    if (group.second.first < 2) {
      continue;
    }
    UnsupportedRef ref;
    ref.op = "canvas_item_set_draw_index";
    ref.has_item = true;
    ref.item = group.second.second;
    ref.reason = UnsupportedReason::DrawIndexTie;
    out->push_back(std::move(ref));
  }
}

Snapshot Mirror::snapshot(std::uint64_t seq, std::uint64_t frame) const {
  std::lock_guard<std::mutex> lock(mutex_);
  Snapshot out;
  out.seq = seq;
  out.frame = frame;
  out.failures = failures_;

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
  out.unsupported.insert(out.unsupported.end(), session_unsupported_.begin(),
                         session_unsupported_.end());

  // Item-level entries: unsupported-op once per distinct command name,
  // unsupported-state for a material, draw-index-tie per container; then
  // ordered by item id, then op (byte order).
  std::vector<UnsupportedRef> item_level;
  for (const auto &entry : items_) {
    const Item &item = entry.second;
    const ItemState &state = item.state;
    std::vector<std::string> seen;
    for (const Command &command : state.commands) {
      if (command.kind != CommandKind::Unsupported ||
          std::find(seen.begin(), seen.end(), command.name) != seen.end()) {
        continue;
      }
      seen.push_back(command.name);
      UnsupportedRef ref;
      ref.op = command.name;
      ref.has_item = true;
      ref.item = state.id;
      ref.reason = UnsupportedReason::UnsupportedOp;
      item_level.push_back(std::move(ref));
    }
    if (item.unsupported_state) {
      UnsupportedRef ref;
      ref.op = "canvas_item_set_material";
      ref.has_item = true;
      ref.item = state.id;
      ref.reason = UnsupportedReason::UnsupportedState;
      item_level.push_back(std::move(ref));
    }
    find_ties(state.children, &item_level);
  }
  for (const auto &entry : canvases_) {
    find_ties(entry.second.state.items, &item_level);
  }
  std::sort(item_level.begin(), item_level.end(),
            [](const UnsupportedRef &a, const UnsupportedRef &b) {
              return a.item != b.item ? a.item < b.item : a.op < b.op;
            });
  out.unsupported.insert(out.unsupported.end(), std::make_move_iterator(item_level.begin()),
                         std::make_move_iterator(item_level.end()));

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

void mirror_fail_root_size_enforce(const std::string &detail) {
  mirror_instance().fail_root_size_enforce(detail);
}

void mirror_set_degenerate_host_size(bool on) { mirror_instance().set_degenerate_host_size(on); }

void mirror_set_drop_frame(std::uint64_t frame) { mirror_instance().set_drop_frame(frame); }

void mirror_set_omit_op(const std::string &op, std::uint64_t from_frame) {
  mirror_instance().set_omit_op(op, from_frame);
}

std::uint64_t mirror_epoch() { return mirror_instance().epoch(); }

Snapshot mirror_snapshot(std::uint64_t seq, std::uint64_t frame) {
  return mirror_instance().snapshot(seq, frame);
}

MirrorStats mirror_stats() { return mirror_instance().stats(); }

}  // namespace rs
}  // namespace grc
