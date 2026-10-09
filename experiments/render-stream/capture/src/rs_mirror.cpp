#include "rs_mirror.h"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <iterator>
#include <map>
#include <set>
#include <utility>

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
  degenerate_host_size_ = false;
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
  ++stats_.free_unknown;  // meshes, materials, ... share this slot
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
  if (item->state.commands.size() >= kMaxCommandsPerItem) {
    ++stats_.dropped_capacity;
    fail(FailureReason::MirrorCapacity, "commands > " + u64(kMaxCommandsPerItem) +
                                            " item=" + u64(item->state.id) + " frame=" + u64(frame));
    return;
  }
  item->state.commands.push_back(std::move(command));
  ++item->state.content_version;
}

// --- textures (G2b2) ----------------------------------------------------------------

namespace {

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
               TextureReason *reason, PayloadPtr *held) {
  if (copy.status == "ok" && bytes != nullptr) {
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
      if ((command.kind == CommandKind::AddTextureRect ||
           command.kind == CommandKind::AddTextureRectRegion) &&
          command.has_tex && command.tex == id) {
        return true;
      }
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
}

TextureEntry Mirror::wire_entry(const Texture &texture) {
  TextureEntry out;
  out.id = texture.id;
  out.kind = texture.kind;
  out.status = texture.status;
  out.version = texture.version;
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
    out.payload_bytes = static_cast<std::uint64_t>(std::max<std::int64_t>(copy.payload_bytes, 0));
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
  if (!texture_ref(texture, &command.has_tex, &command.tex)) {
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
  if (!texture_ref(texture, &command.has_tex, &command.tex)) {
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = UnsupportedCmdReason::UnknownTexture;
  } else {
    command.kind = CommandKind::AddTextureRectRegion;
    command.transpose = transpose;
    command.clip_uv = clip_uv;
    command.rect = rect;
    command.src = src;
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
                               std::uint64_t frame) {
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
            &texture.bytes);
  texture_by_rid_[rid] = texture.id;
  textures_.emplace(texture.id, std::move(texture));
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
                               int layer, std::uint64_t frame) {
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
    take_copy(copy, std::move(bytes), &texture->status, &texture->has_reason, &texture->reason,
              &texture->bytes);
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
    } else {
      t->status = TextureStatus::Unsupported;
      t->has_reason = true;
      t->reason = TextureReason::UnknownTexture;
      t->bytes.reset();
    }
  }
  if (b != nullptr) {
    // The storage frees the by-texture itself (texture_storage.cpp:1434): its id leaves the
    // table (or stays as a tombstone while a command still names it).
    retire_texture(b->id);
  }
}

std::uint64_t Mirror::spurious_texture_update(std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  (void)frame;
  for (auto &entry : textures_) {
    Texture &texture = entry.second;
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

Captured Mirror::snapshot(std::uint64_t seq, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Captured captured;
  Snapshot &out = captured.state;
  out.seq = seq;
  out.frame = frame;
  out.failures = failures_;
  out.default_texture_filter = default_filter_;
  out.default_texture_repeat = default_repeat_;

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

  // A tombstone leaves the table at the first snapshot in which nothing names it
  // (gate2-design.md Q3).
  std::set<std::uint32_t> referenced;
  for (const auto &entry : items_) {
    for (const Command &command : entry.second.state.commands) {
      if ((command.kind == CommandKind::AddTextureRect ||
           command.kind == CommandKind::AddTextureRectRegion) &&
          command.has_tex) {
        referenced.insert(command.tex);
      }
    }
  }
  for (auto it = textures_.begin(); it != textures_.end();) {
    if (it->second.status == TextureStatus::Freed && referenced.count(it->first) == 0) {
      it = textures_.erase(it);
    } else {
      ++it;
    }
  }

  // Item-level entries (render-stream-2.md "Item-level unsupported entries"): one per distinct
  // (op, reason) pair of each item -- an unsupported command's name and reason, a texture draw
  // naming an unsupported texture (unsupported-texture), a material (unsupported-state) -- and
  // draw-index-tie per container; then ordered by item id, then op, then reason (byte order).
  std::vector<UnsupportedRef> item_level;
  const auto add_item_entry = [&item_level](std::uint32_t item, const std::string &op,
                                            UnsupportedReason reason) {
    for (const UnsupportedRef &ref : item_level) {
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
  for (const auto &entry : items_) {
    const Item &item = entry.second;
    const ItemState &state = item.state;
    for (const Command &command : state.commands) {
      if (command.kind == CommandKind::Unsupported) {
        add_item_entry(state.id, command.name,
                       command.unsupported_reason == UnsupportedCmdReason::UnknownTexture
                           ? UnsupportedReason::UnknownTexture
                           : UnsupportedReason::UnsupportedOp);
      } else if ((command.kind == CommandKind::AddTextureRect ||
                  command.kind == CommandKind::AddTextureRectRegion) &&
                 command.has_tex) {
        const auto texture = textures_.find(command.tex);
        if (texture != textures_.end() && texture->second.status == TextureStatus::Unsupported) {
          add_item_entry(state.id,
                         command.kind == CommandKind::AddTextureRect
                             ? "canvas_item_add_texture_rect"
                             : "canvas_item_add_texture_rect_region",
                         UnsupportedReason::UnsupportedTexture);
        }
      }
    }
    if (item.unsupported_state) {
      add_item_entry(state.id, "canvas_item_set_material", UnsupportedReason::UnsupportedState);
    }
    find_ties(state.children, &item_level);
  }
  for (const auto &entry : canvases_) {
    find_ties(entry.second.state.items, &item_level);
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
  out.items.reserve(items_.size());
  for (const auto &entry : items_) {
    out.items.push_back(entry.second.state);
  }
  out.textures.reserve(textures_.size());
  for (const auto &entry : textures_) {
    const Texture &texture = entry.second;
    out.textures.push_back(wire_entry(texture));
    if (texture.kind == TextureKind::Image && texture.status == TextureStatus::Ok &&
        texture.bytes != nullptr) {
      captured.payloads.emplace(texture.copy.hash, texture.bytes);
    }
  }
  return captured;
}

MirrorStats Mirror::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  MirrorStats out = stats_;
  out.live_canvases = canvases_.size();
  out.live_items = items_.size();
  out.live_textures = textures_.size();
  std::set<std::string> hashes;
  for (const auto &entry : textures_) {
    const Texture &texture = entry.second;
    if (texture.bytes != nullptr && hashes.insert(texture.copy.hash).second) {
      out.texture_payload_bytes += texture.bytes->size();
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

void mirror_set_drop_frame(std::uint64_t frame) { mirror_instance().set_drop_frame(frame); }

void mirror_set_omit_op(const std::string &op, std::uint64_t from_frame) {
  mirror_instance().set_omit_op(op, from_frame);
}

std::uint64_t mirror_epoch() { return mirror_instance().epoch(); }

Captured mirror_snapshot(std::uint64_t seq, std::uint64_t frame) {
  return mirror_instance().snapshot(seq, frame);
}

MirrorStats mirror_stats() { return mirror_instance().stats(); }

}  // namespace rs
}  // namespace grc
