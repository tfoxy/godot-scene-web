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

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs_sha256.h"
#include "rs_shader_payload.h"
#include "rs_records.h"
#include "rs_texture_payload.h"

namespace grc {
namespace rs {

using namespace rs2;  // NOLINT: the wire types are the mirror's own types

namespace {
// HC4a: the shadow oracle's test defaults (Mirror::set_default_hc_shadow) and its account.
std::atomic<bool> g_default_hc_shadow{false};
std::atomic<std::uint64_t> g_hc_shadow_mismatches{0};
}  // namespace

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

Mirror::Mirror() {
  reset();
  hc_shadow_ = g_default_hc_shadow.load();  // HC4a: tests only (set_default_hc_shadow)
}

void Mirror::reset() {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  drop_frame_ = 0;
  omit_op_.clear();
  omit_armed_.store(false, std::memory_order_release);
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
  multimeshes_.clear();
  multimesh_by_rid_.clear();
  next_multimesh_id_ = 1;
  stale_buffer_multimesh_ = 0;
  multimesh_notes_.clear();
  particles_.clear();
  particles_by_rid_.clear();
  next_particles_id_ = 1;
  drop_restart_done_ = false;
  particles_notes_.clear();
  pending_emits_.clear();
  emit_tail_.reset();
  shaders_.clear();
  shader_by_rid_.clear();
  next_shader_id_ = 1;
  materials_.clear();
  material_by_rid_.clear();
  next_material_id_ = 1;
  shader_policy_ = ShaderPolicy::Source;
  perturb_shader_frame_ = 0;
  stale_dynamic_mesh_ = 0;
  dynamic_hash_readers_ = true;  // HC3
  default_filter_ = Filter::Linear;
  default_repeat_ = Repeat::Disabled;
  failures_.clear();
  session_unsupported_.clear();
  stats_ = MirrorStats();
  // HC4a: the next snapshot rebuilds the published tables (items_.clear() marked every item).
  pub_valid_ = false;
  withheld_prev_.clear();
  hc_stale_derived_used_ = false;
  hc_shadow_failure_.clear();
  hc_shadow_have_prev_ = false;
  hc_shadow_prev_ = Snapshot();
  hc_shadow_prev_full_ = Snapshot();
  hc_shadow_prev_captured_ = Captured();

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
  pub_valid_ = false;  // HC4a: what is published depends on it; rebuild
}

void Mirror::set_drop_frame(std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  drop_frame_ = frame;
}

void Mirror::set_omit_op(const std::string &op, std::uint64_t from_frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  omit_op_ = op;
  omit_armed_.store(!op.empty(), std::memory_order_release);
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

void Mirror::set_v11(const V11Options &options) {
  std::lock_guard<std::mutex> lock(mutex_);
  v11_ = options;
  pub_valid_ = false;  // HC4a: the published content_versions depend on it; rebuild
}

void Mirror::set_dynamic_hash_readers(bool readers) {
  std::lock_guard<std::mutex> lock(mutex_);
  dynamic_hash_readers_ = readers;
}

bool Mirror::dynamic_hashes_read() const {
  return dynamic_hash_readers_ || !v11_.enabled || v11_.stale_dynamic_frame != 0;
}

void Mirror::set_carry_shader_time(bool carry) {
  std::lock_guard<std::mutex> lock(mutex_);
  carry_shader_time_ = carry;
}

void Mirror::set_shader_time(double time) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!carry_shader_time_ || time == shader_time_) {
    return;
  }
  shader_time_ = time;
  for (const auto &entry : shaders_) {
    if (reads_time(entry.second)) {
      ++epoch_;  // a TIME reader's picture moves with the time alone
      return;
    }
  }
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
  // HC6: the entry pointer directly, no items_ lookup. HC4a: a hook that looks an item up for
  // writing marks it.
  items_.mark(it->second.item);
  return it->second.item;
}

const Mirror::Item *Mirror::peek_item(std::uint64_t rid) const {
  const auto it = item_by_rid_.find(rid);
  return it != item_by_rid_.end() ? it->second.item : nullptr;
}

bool Mirror::find_target(std::uint64_t rid, Target *out) const {
  if (rid == 0) {
    return false;
  }
  const auto item = item_by_rid_.find(rid);
  if (item != item_by_rid_.end()) {
    *out = {Kind::Item, item->second.id};
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
    Item *parent = items_.mut(id);  // HC4a: its child list is about to change
    return parent != nullptr ? &parent->state.children : nullptr;
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
    const Item *parent = items_.find(cur->state.parent.id);
    if (parent == nullptr) {
      return false;
    }
    cur = parent;
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
  for (const auto &entry : items_.all()) {
    if (entry.second.unknown_parent != 0) {
      any_unknown_parent = true;
      break;
    }
  }
  if (!any_unknown_parent) {
    return out;
  }
  for (const auto &entry : items_.all()) {
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
    const Item *found = items_.find(id);
    if (found == nullptr || !seen.insert(id).second) {
      continue;
    }
    order.push_back(id);
    const std::vector<std::uint32_t> &children = found->state.children;
    for (auto child = children.rbegin(); child != children.rend(); ++child) {
      stack.push_back(*child);
    }
  }
  // Only an id a receiver has seen needs replacing; the others keep theirs.
  std::map<std::uint32_t, std::uint32_t> renamed;
  for (std::uint32_t id : order) {
    if (items_.find(id)->published) {
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
  const Item &root = *items_.find(root_id);
  if (renamed.count(root_id) != 0 &&
      !(root.state.parent.kind == ParentKind::Item && seen.count(root.state.parent.id) != 0)) {
    if (std::vector<std::uint32_t> *list = children_of(root.state.parent.kind, root.state.parent.id)) {
      std::replace(list->begin(), list->end(), root_id, renamed.at(root_id));
    }
  }
  std::vector<Item> staged;
  staged.reserve(order.size());
  for (std::uint32_t id : order) {
    // HC4a: the old id leaves the table (gone), the new one is emplaced (dirty).
    Item item = std::move(*items_.mut(id));
    items_.erase(id);
    item.state.id = rename(id);
    item.published = false;
    for (std::uint32_t &child : item.state.children) {
      child = rename(child);
    }
    if (item.state.parent.kind == ParentKind::Item) {
      item.state.parent.id = rename(item.state.parent.id);
    }
    staged.push_back(std::move(item));
  }
  for (Item &item : staged) {
    const std::uint32_t id = item.state.id;
    Item &placed = items_.emplace(id, std::move(item));
    item_by_rid_[placed.rid] = {id, &placed};  // HC6: the new node
  }
  stats_.rekeyed_items += renamed.size();
}

bool Mirror::forget_unknown(std::uint64_t rid) {
  if (!skip_unknown() || unknown_rids_.erase(rid) == 0) {
    return false;
  }
  std::vector<std::uint32_t> orphans;
  for (const auto &entry : items_.all()) {
    if (entry.second.unknown_parent == rid) {
      orphans.push_back(entry.first);
    }
  }
  for (std::uint32_t id : orphans) {
    items_.mut(id)->unknown_parent = 0;  // orphaned: no parent, as renderer_canvas_cull.cpp does
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
  const std::uint32_t id = item.state.id;
  Item &placed = items_.emplace(id, std::move(item));
  item_by_rid_[rid] = {id, &placed};  // HC6: the entry's node, stable until erased
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
      if (Item *orphan = items_.mut(child)) {
        orphan->state.parent = ParentRef();
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
      if (Item *orphan = items_.mut(child)) {
        orphan->state.parent = ParentRef();
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
  if (Multimesh *mm = find_multimesh(rid)) {
    // PM1 (rule 2): version + 1, a `freed` tombstone while an add_multimesh names it.
    MultimeshCall ignored;
    multimesh_by_rid_.erase(rid);
    mm->rid = 0;
    mm->freed = true;
    mm->buffer.reset();
    multimesh_moved(mm, &ignored);
    if (!multimesh_referenced(mm->id)) {
      note_multimesh(*mm, frame);
      multimeshes_.erase(mm->id);
    }
    return;
  }
  if (Particles *pt = find_particles(rid)) {
    retire_particles(pt, frame);  // PM5: as particles_free (the hook calls that directly)
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
    const std::uint32_t id = mesh_it->second.id;
    retire_mesh(id);
    return;
  }
  const auto shader_it = shader_by_rid_.find(rid);
  if (shader_it != shader_by_rid_.end()) {
    // G55d (D5; g3ms.cpp:2184-2198): freeing a shader sets every material naming it to no shader
    // (version + 1); no tombstone.
    ++epoch_;
    const std::uint32_t id = shader_it->second;
    for (auto &entry : materials_.unmarked()) {
      Material &material = entry.second;
      if (material.has_shader && material.shader == id) {
        materials_.mark(entry.first, &material);  // HC4b
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
    std::vector<std::uint32_t> users;
    for (const auto &entry : items_.all()) {
      if (entry.second.state.has_material && entry.second.state.material == id) {
        users.push_back(entry.first);
      }
    }
    for (std::uint32_t user : users) {
      ItemState &state = items_.mut(user)->state;
      state.has_material = false;
      state.material = 0;
    }
    // PM5: an emitter whose process material it was now names an unknown material.
    for (auto &entry : particles_) {
      Particles &pt = entry.second;
      if (!pt.freed && pt.material_id == id) {
        pt.material_id = 0;
        pt.unknown_material = true;
        ParticlesCall ignored;
        particles_moved(&pt, &ignored);
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
    item->state.commands.clear_for_rerecord(&item->spare_commands);
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
  // HC6: built in place in the item's list (nothing between the lookup and the push has a side
  // effect, so the capacity check may come first).
  if (Command *command = emplace_command(item, frame)) {
    command->kind = CommandKind::AddRect;
    command->antialiased = antialiased;
    command->rect = rect;
    command->color = color;
  }
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

// HC6: by reference, so the command moves once (into the list), not twice.
void Mirror::push_command(Item *item, Command &&command, std::uint64_t frame) {
  if (!command_room(item, frame)) {
    return;
  }
  item->state.commands.push_back(std::move(command));
  ++item->state.content_version;
}

Command *Mirror::emplace_command(Item *item, std::uint64_t frame) {
  if (!command_room(item, frame)) {
    return nullptr;
  }
  ++item->state.content_version;
  return &item->state.commands.emplace_back();
}

bool Mirror::command_room(Item *item, std::uint64_t frame) {
  if (item->state.commands.size() < max_commands_) {
    return true;
  }
  ++stats_.dropped_capacity;
  fail(FailureReason::MirrorCapacity, "commands > " + u64(max_commands_) +
                                          " item=" + u64(item->state.id) + " frame=" + u64(frame));
  return false;
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
    case CommandKind::AddMultimesh:  // PM1 rule 7: `tex` as every /4 op with one
    case CommandKind::AddParticles:  // PM5: `tex` as every /4 op with one
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
    case CommandKind::AddMultimesh: return "canvas_item_add_multimesh";
    case CommandKind::AddParticles: return "canvas_item_add_particles";
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
  if (!omit_armed_.load(std::memory_order_acquire)) {
    return false;  // HC6: no omit-op sabotage this session; no lock
  }
  std::lock_guard<std::mutex> lock(mutex_);
  return omit_op_matches(op, frame);
}

Mirror::Texture *Mirror::find_texture(std::uint64_t rid) {
  const auto it = texture_by_rid_.find(rid);
  return it == texture_by_rid_.end() ? nullptr : textures_.mut(it->second);  // HC4b: marks
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
  for (const auto &entry : items_.all()) {
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
  for (const auto &entry : items_.all()) {
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
  Texture *found = textures_.mut(id);
  if (found == nullptr) {
    return;
  }
  Texture &texture = *found;
  if (texture.rid != 0) {
    texture_by_rid_.erase(texture.rid);
    texture.rid = 0;
  }
  if (!texture_referenced(id)) {
    textures_.erase(id);
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
  // 1. Start: every settled ok image whose current content has no Basis outcome yet (D12). HC4b:
  // settling and recovering change only textures in tex_jobbed_, which every snapshot revisits;
  // the attach below marks what it changes.
  for (auto &entry : textures_.unmarked()) {
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
  for (auto &entry : textures_.unmarked()) {
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
    textures_.mark(entry.first, &texture);  // HC4b: a new variant
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
  pub_valid_ = false;  // HC4a: item-level entries read the pending set; rebuild
}

std::uint64_t Mirror::pending_published() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return pending_published_;
}

void Mirror::service_pending() {
  std::lock_guard<std::mutex> lock(mutex_);
  bool moved = false;
  // HC4b: a texture with a pending version is in tex_jobbed_ (the snapshot that carried it
  // pending put it there), and every snapshot revisits those.
  Mirror::ResMap<Texture>::Map &textures = textures_.unmarked();
  for (std::uint32_t id : tex_jobbed_) {
    const auto it = textures.find(id);
    if (it == textures.end() || it->second.pending_version == 0) {
      continue;
    }
    Texture &texture = it->second;
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
  // HC6: built in place (nothing from here to the end of the call has a side effect).
  Command *placed = emplace_command(item, frame);
  if (placed == nullptr) {
    return;
  }
  Command &command = *placed;
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
  // HC6: built in place (nothing from here to the end of the call has a side effect).
  Command *placed = emplace_command(item, frame);
  if (placed == nullptr) {
    return;
  }
  Command &command = *placed;
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
  // HC6: built in place (nothing from here to the end of the call has a side effect).
  Command *placed = emplace_command(item, frame);
  if (placed == nullptr) {
    return;
  }
  Command &command = *placed;
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
  // HC6: built in place (nothing from here to the end of the call has a side effect).
  Command *placed = emplace_command(item, frame);
  if (placed == nullptr) {
    return;
  }
  Command &command = *placed;
  command.kind = CommandKind::AddSetTransform;
  command.transform = transform;
}

void Mirror::add_clip_ignore(std::uint64_t rid, bool ignore, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Item *item = geometry_item(rid, "canvas_item_add_clip_ignore", frame);
  if (item == nullptr) {
    return;
  }
  // HC6: built in place (nothing from here to the end of the call has a side effect).
  Command *placed = emplace_command(item, frame);
  if (placed == nullptr) {
    return;
  }
  Command &command = *placed;
  command.kind = CommandKind::AddClipIgnore;
  command.clip_ignore = ignore;
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

const Mirror::Mesh *Mirror::peek_mesh(std::uint64_t rid) const {
  const auto it = mesh_by_rid_.find(rid);
  return it == mesh_by_rid_.end() ? nullptr : it->second.mesh;  // HC6: the entry directly
}

Mirror::Mesh *Mirror::find_mesh(std::uint64_t rid) {
  const auto it = mesh_by_rid_.find(rid);
  if (it == mesh_by_rid_.end()) {
    return nullptr;
  }
  meshes_.mark(it->second.id, it->second.mesh);  // HC4b: marks; HC6: the entry directly
  return it->second.mesh;
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

Mirror::MeshSurf Mirror::mesh_surface(const MeshSurfaceInput &input, std::uint64_t frame) {
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
  // HC3: the hook's payload, shared with nothing else the mirror keeps (a region write copies it
  // first, `writable` being null), and the hook's own hash of it.
  out.bytes = input.bytes;
  out.key = next_surface_key_++;
  out.hash = input.copy.hash;
  if (perturb_vertex_frame_ != 0 && frame >= perturb_vertex_frame_ && out.vertex_count > 0 &&
      first_vertex_offset(*input.bytes) != 0) {
    // Q3c (G5e): the recorded payload's first vertex x + 1.0, as a new copy re-hashed; the
    // engine, the hook's retained buffers and the hook log keep the true bytes. HC3: `bytes`
    // stays true; the copy is built when a snapshot publishes it, its hash when read.
    out.perturb = true;
    out.hash.clear();
  }
  return out;
}

namespace {

// perturb-vertex (Q3c): `payload` with its first vertex x + 1.0, as a new copy.
PayloadPtr perturbed_copy(const PayloadBytes &payload) {
  const std::size_t offset = first_vertex_offset(payload);
  auto copy = std::make_shared<PayloadBytes>(payload);
  if (offset != 0) {
    float x = 0.0f;
    std::memcpy(&x, copy->data() + offset, sizeof(x));
    x += 1.0f;
    std::memcpy(copy->data() + offset, &x, sizeof(x));
  }
  return copy;
}

// perturb-vertex: whether x + 1.0 moves a bit of `payload`'s first vertex x (not for |x| >= 2^24,
// an infinity or a NaN that stays one).
bool perturb_moves(const PayloadBytes &payload) {
  const std::size_t offset = first_vertex_offset(payload);
  if (offset == 0) {
    return false;
  }
  float x = 0.0f;
  std::memcpy(&x, payload.data() + offset, sizeof(x));
  const float y = x + 1.0f;
  return std::memcmp(&x, &y, sizeof(x)) != 0;
}

}  // namespace

bool Mirror::apply_region(MeshSurf *surface, const MeshRegionWrite &write, std::uint64_t frame) {
  if (!surface->ok || surface->bytes == nullptr || write.data == nullptr || write.size == 0 ||
      write.offset > surface->bytes->size() || write.size > surface->bytes->size() - write.offset) {
    return false;  // never happens: the hook checked the bounds against its own copy (D8)
  }
  const bool differs =
      std::memcmp(surface->bytes->data() + write.offset, write.data, write.size) != 0;
  // perturb-vertex starts applying to a surface at its first update at or after its frame (as the
  // re-encoded surface the hook handed over before HC3 did).
  const bool starts = perturb_vertex_frame_ != 0 && frame >= perturb_vertex_frame_ &&
                      surface->vertex_count > 0 && !surface->perturb &&
                      first_vertex_offset(*surface->bytes) != 0;
  if (differs) {
    if (surface->writable == nullptr) {
      // Published (or still the hook's): copy before writing. Once per surface per snapshot.
      surface->writable = std::make_shared<PayloadBytes>(*surface->bytes);
      surface->bytes = surface->writable;
      ++stats_.mesh_payload_copies;
    }
    std::memcpy(surface->writable->data() + write.offset, write.data, write.size);
  }
  if (starts) {
    surface->perturb = true;
  }
  // W11b: a content change only when the published bytes differ (before HC3: when the re-encoded
  // payload's SHA-256 did); an update writing the bytes already there changes nothing.
  const bool changed = differs || (starts && perturb_moves(*surface->bytes));
  if (changed || starts) {
    surface->hash.clear();
    surface->perturbed.reset();
    surface->body.reset();
  }
  if (changed) {
    surface->key = next_surface_key_++;
  }
  return changed;
}

PayloadPtr Mirror::publish_surface(MeshSurf *surface) {
  if (surface->bytes == nullptr) {
    return nullptr;
  }
  if (!surface->perturb) {
    surface->writable.reset();  // a snapshot shares `bytes` now: the next write copies it
    return surface->bytes;
  }
  if (surface->perturbed == nullptr) {
    surface->perturbed = perturbed_copy(*surface->bytes);
  }
  return surface->perturbed;
}

const std::string &Mirror::surface_hash(MeshSurf *surface, bool dynamic) {
  if (surface->hash.empty() && surface->bytes != nullptr) {
    const PayloadPtr published = publish_surface(surface);
    surface->hash = sha256_hex(published->data(), published->size());
    ++stats_.mesh_surface_hashes;
    if (dynamic) {
      ++stats_.dynamic_surface_hashes;
    }
  }
  return surface->hash;
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
  for (const auto &entry : items_.all()) {
    for (const Command &command : entry.second.state.commands) {
      if (command.kind == CommandKind::AddMesh && command.mesh == id) {
        return true;
      }
    }
  }
  // PM1 (rule 6, multimesh-ref): a multimesh's mesh keeps its tombstone too.
  for (const auto &entry : multimeshes_) {
    const Multimesh &mm = entry.second;
    if (!mm.freed && !mm.unknown_mesh && mm.mesh_id == id) {
      return true;
    }
  }
  // PM5 (particles-ref): so does an emitter's draw pass mesh.
  for (const auto &entry : particles_) {
    const Particles &pt = entry.second;
    for (std::size_t k = 0; !pt.freed && k < pt.pass_ids.size(); ++k) {
      if (!pt.pass_unknown[k] && pt.pass_ids[k] == id) {
        return true;
      }
    }
  }
  return false;
}

void Mirror::retire_mesh(std::uint32_t id) {
  Mesh *found = meshes_.mut(id);
  if (found == nullptr) {
    return;
  }
  Mesh &mesh = *found;
  if (mesh.rid != 0) {
    mesh_by_rid_.erase(mesh.rid);
    mesh.rid = 0;
  }
  if (!mesh_referenced(id)) {
    meshes_.erase(id);
    return;
  }
  // render-stream-4.md "Mesh table": a tombstone keeps its id and version, drops its surfaces;
  // a command naming it draws nothing (gate5-design.md Q1d).
  mesh.status = MeshStatus::Freed;
  mesh.has_reason = false;
  mesh.surfaces.clear();
}

namespace {

// W11b (render-stream-11.md "Mesh entry"): a GRM1 payload without its 8-byte magic, its u32le
// meta length and its meta -- the 40 geometry bytes, then the vertex, attribute, skin and index
// bytes. Empty when `payload` is too short to hold its own header (never for a hook's payload).
// W11b (render-stream-11.md "Stable `content_version`"): an item's stable content_version, the
// first 53 bits of the SHA-256 of its encoded command list (JSON, then the f32 and i32 blocks,
// each length-prefixed), never 0. 53 bits keep it an exact JSON number in every decoder; a
// collision between two lists one item holds at a base and a target is a 2^-53 event.
std::uint64_t command_list_digest(const std::vector<Command> &commands) {
  std::string json;
  std::vector<float> f32;
  std::vector<std::int32_t> i32;
  encode_command_list(commands, &json, &f32, &i32);
  Sha256 sha;
  const auto put_len = [&sha](std::uint64_t n) {
    std::uint8_t b[8];
    for (int k = 0; k < 8; ++k) {
      b[k] = static_cast<std::uint8_t>(n >> (8 * k));
    }
    sha.update(b, sizeof(b));
  };
  put_len(json.size());
  sha.update(json.data(), json.size());
  put_len(f32.size());
  if (!f32.empty()) {
    sha.update(f32.data(), f32.size() * sizeof(float));  // the host is little-endian (abi.h)
  }
  put_len(i32.size());
  if (!i32.empty()) {
    sha.update(i32.data(), i32.size() * sizeof(std::int32_t));
  }
  const std::array<std::uint8_t, 32> digest = sha.finish();
  std::uint64_t v = 0;
  for (int k = 0; k < 7; ++k) {
    v |= static_cast<std::uint64_t>(digest[static_cast<std::size_t>(k)]) << (8 * k);
  }
  v &= (std::uint64_t{1} << 53) - 1;
  return v == 0 ? 1 : v;
}

// HC2 sabotage `rerecord-stale` (V11Options): a re-record counts as identical when its commands
// have the published list's kinds, so a list that differs in one float keeps the stale list.
bool same_command_kinds(const std::vector<Command> &a, const std::vector<Command> &b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (a[i].kind != b[i].kind) {
      return false;
    }
  }
  return true;
}

std::shared_ptr<const std::vector<std::uint8_t>> mesh_body(const PayloadBytes &payload) {
  if (payload.size() < 12) {
    return std::make_shared<const std::vector<std::uint8_t>>();
  }
  const std::uint32_t meta = static_cast<std::uint32_t>(payload[8]) |
                             (static_cast<std::uint32_t>(payload[9]) << 8) |
                             (static_cast<std::uint32_t>(payload[10]) << 16) |
                             (static_cast<std::uint32_t>(payload[11]) << 24);
  const std::size_t start = 12 + static_cast<std::size_t>(meta);
  if (start > payload.size()) {
    return std::make_shared<const std::vector<std::uint8_t>>();
  }
  return std::make_shared<const std::vector<std::uint8_t>>(
      payload.begin() + static_cast<std::ptrdiff_t>(start), payload.end());
}

}  // namespace

void Mirror::mesh_changed(Mesh *mesh, std::uint64_t frame) {
  if (!v11_.enabled) {
    return;
  }
  ++stats_.mesh_content_changes;
  // stale-dynamic: the first dynamic mesh that changes at or after the frame keeps its serial.
  const bool stale = v11_.stale_dynamic_frame != 0 && frame >= v11_.stale_dynamic_frame &&
                     mesh->dynamic &&
                     (stale_dynamic_mesh_ == 0 || stale_dynamic_mesh_ == mesh->id);
  if (stale) {
    stale_dynamic_mesh_ = mesh->id;
  } else {
    ++mesh->content_serial;
  }
  // Classification counts change frames: never the frame the mesh was built in, once per frame.
  if (frame == mesh->born_frame || frame == mesh->change_frame) {
    return;
  }
  if (mesh->change_frame != 0 &&
      frame - mesh->change_frame <= static_cast<std::uint64_t>(v11_.mesh_dynamic.frames)) {
    mesh->promote = true;
  }
  mesh->change_frame = frame;
}

void Mirror::classify_mesh(Mesh *mesh) {
  const bool wanted = v11_.enabled && !mesh->dynamic &&
                      (v11_.mesh_dynamic.mode == MeshDynamicMode::All ||
                       (v11_.mesh_dynamic.mode == MeshDynamicMode::Auto && mesh->promote));
  mesh->promote = false;
  if (!wanted || mesh->status != MeshStatus::Ok || mesh->surfaces.empty()) {
    return;
  }
  std::uint64_t total = 0;
  for (MeshSurf &surface : mesh->surfaces) {
    if (!surface.ok || surface.bytes == nullptr) {
      return;
    }
    if (surface.body == nullptr) {
      surface.body = mesh_body(*publish_surface(&surface));
    }
    total += surface.body->size();
  }
  if (total == 0 || total > v11_.mesh_dynamic.max_bytes) {
    return;  // max_bytes 0: no mesh qualifies, as `off`
  }
  mesh->dynamic = true;
  ++stats_.mesh_promotions;
}

MeshEntry Mirror::wire_mesh(Mesh *mesh_ptr,
                            std::vector<std::pair<std::string, PayloadPtr>> *payloads) {
  Mesh &mesh = *mesh_ptr;
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
    // W11b: a dynamic entry's surfaces also carry their bodies (render-stream-11.md).
    const bool dynamic = v11_.enabled && mesh.dynamic && !mesh.surfaces.empty();
    // HC3 (host-cost-design.md D2): a static surface's hash names its payload on the wire, so it
    // is always computed (once per content); a dynamic one's only when something reads it.
    const bool hashed = !dynamic || dynamic_hashes_read();
    out.surfaces.reserve(mesh.surfaces.size());
    for (MeshSurf &surface : mesh.surfaces) {
      MeshSurface wire;
      PayloadPtr published;
      if (surface.bytes != nullptr) {
        published = publish_surface(&surface);
        if (hashed) {
          wire.hash = surface_hash(&surface, dynamic);
        } else {
          wire.hash = "hc3-key:" + std::to_string(surface.key);
          wire.hash_is_key = true;
        }
      } else {
        wire.hash = surface.hash;
      }
      wire.payload_bytes = published != nullptr ? published->size() : 0;
      wire.primitive = static_cast<Primitive>(surface.primitive);
      wire.format = surface.format;
      wire.vertex_count = surface.vertex_count;
      wire.index_count = surface.index_count;
      if (dynamic && published != nullptr) {
        if (surface.body == nullptr) {
          surface.body = mesh_body(*published);
        }
        wire.body = surface.body;
      }
      if (payloads != nullptr && published != nullptr) {
        payloads->emplace_back(wire.hash, std::move(published));
      }
      out.surfaces.push_back(std::move(wire));
    }
    if (dynamic) {
      out.dynamic = true;
      out.content_serial = mesh.content_serial;
    }
  }
  return out;
}

MeshEntry Mirror::wire_mesh_peek(const Mesh &mesh,
                                 std::vector<std::pair<std::string, PayloadPtr>> *payloads) const {
  // wire_mesh() as the full walk ran it, computing what wire_mesh() caches (the perturbed copy,
  // the hash, the /11 body) locally when the cache is empty, so the oracle moves no counter.
  MeshEntry out;
  out.id = mesh.id;
  out.status = mesh.status;
  out.version = mesh.version;
  out.origin = mesh.origin;
  out.adopted_content = mesh.adopted_content;
  out.has_reason = mesh.status == MeshStatus::Unsupported && mesh.has_reason;
  out.reason = mesh.reason;
  out.has_aabb = mesh.status != MeshStatus::Freed;
  if (out.has_aabb) {
    out.custom_aabb = mesh.custom_aabb;
  }
  if (mesh.status == MeshStatus::Ok) {
    const bool dynamic = v11_.enabled && mesh.dynamic && !mesh.surfaces.empty();
    const bool hashed = !dynamic || dynamic_hashes_read();
    for (const MeshSurf &surface : mesh.surfaces) {
      MeshSurface wire;
      PayloadPtr published;
      if (surface.bytes != nullptr) {
        published = !surface.perturb            ? surface.bytes
                    : surface.perturbed != nullptr ? surface.perturbed
                                                   : perturbed_copy(*surface.bytes);
        if (hashed) {
          wire.hash = !surface.hash.empty() ? surface.hash
                                            : sha256_hex(published->data(), published->size());
        } else {
          wire.hash = "hc3-key:" + std::to_string(surface.key);
          wire.hash_is_key = true;
        }
      } else {
        wire.hash = surface.hash;
      }
      wire.payload_bytes = published != nullptr ? published->size() : 0;
      wire.primitive = static_cast<Primitive>(surface.primitive);
      wire.format = surface.format;
      wire.vertex_count = surface.vertex_count;
      wire.index_count = surface.index_count;
      if (dynamic && published != nullptr) {
        wire.body = surface.body != nullptr ? surface.body : mesh_body(*published);
      }
      if (payloads != nullptr && published != nullptr) {
        payloads->emplace_back(wire.hash, std::move(published));
      }
      out.surfaces.push_back(std::move(wire));
    }
    if (dynamic) {
      out.dynamic = true;
      out.content_serial = mesh.content_serial;
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
    retire_mesh(stale->second.id);  // a recycled RID value: the old id is gone
  }
  Mesh mesh;
  mesh.id = next_mesh_id_++;
  mesh.rid = rid;
  mesh.born_frame = frame;
  const std::uint32_t id = mesh.id;
  Mesh &placed = meshes_.emplace(id, std::move(mesh));
  mesh_by_rid_[rid] = {id, &placed};  // HC6: the entry's node, stable until erased
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
    retire_mesh(stale->second.id);
  }
  Mesh mesh;
  mesh.id = next_mesh_id_++;
  mesh.rid = rid;
  mesh.born_frame = frame;
  for (const MeshSurfaceInput &input : surfaces) {
    mesh.surfaces.push_back(mesh_surface(input, frame));
  }
  recompute_mesh_status(&mesh);
  const std::uint32_t id = mesh.id;
  Mesh &placed = meshes_.emplace(id, std::move(mesh));
  mesh_by_rid_[rid] = {id, &placed};  // HC6: the entry's node, stable until erased
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
  mesh.born_frame = frame;
  for (const MeshSurfaceInput &input : surfaces) {
    mesh.surfaces.push_back(mesh_surface(input, frame));
  }
  recompute_mesh_status(&mesh);
  const std::uint32_t id = mesh.id;
  Mesh &placed = meshes_.emplace(id, std::move(mesh));
  mesh_by_rid_[rid] = {id, &placed};  // HC6: the entry's node, stable until erased
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
  mesh_changed(mesh, frame);
  recompute_mesh_status(mesh);
}

void Mirror::mesh_surface_update_region(std::uint64_t rid, const char *op, std::int32_t surface,
                                        bool applied, const MeshRegionWrite *write,
                                        std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Mesh *mesh = mesh_for(rid, op, frame);
  if (mesh == nullptr || !applied) {
    return;  // D8: a rejected (out of bounds, empty) update changes nothing, as in GLES3
  }
  ++epoch_;
  mesh->version += 1;
  if (write != nullptr && surface >= 0 &&
      static_cast<std::size_t>(surface) < mesh->surfaces.size()) {
    // HC3: the region lands in the mirror's copy of the payload; no re-encode, no hash here.
    if (apply_region(&mesh->surfaces[static_cast<std::size_t>(surface)], *write, frame)) {
      mesh_changed(mesh, frame);
    }
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
  mesh_changed(mesh, frame);
  recompute_mesh_status(mesh);
}

void Mirror::mesh_clear(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  Mesh *mesh = mesh_for(rid, "mesh_clear", frame);
  if (mesh == nullptr) {
    return;
  }
  ++epoch_;
  if (!mesh->surfaces.empty()) {
    mesh_changed(mesh, frame);
  }
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
  const Mesh *mesh = peek_mesh(mesh_rid);  // HC4b: a read, no mark
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

// --- multimeshes (PM1; render-stream-11.md "As built (PM1): decisions") -----------------------

namespace {

bool float_bits_equal(const float *a, const float *b, std::size_t n) {
  return n == 0 || std::memcmp(a, b, n * sizeof(float)) == 0;
}

}  // namespace

void Mirror::set_multimesh(const MultimeshOptions &options) {
  std::lock_guard<std::mutex> lock(mutex_);
  mm_options_ = options;
  pub_valid_ = false;  // HC4a: digests and flags depend on it; rebuild
}

Mirror::Multimesh *Mirror::find_multimesh(std::uint64_t rid) {
  if (rid == 0) {
    return nullptr;
  }
  const auto it = multimesh_by_rid_.find(rid);
  return it == multimesh_by_rid_.end() ? nullptr : &multimeshes_.at(it->second);
}

bool Mirror::knows_multimesh(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rid != 0 && multimesh_by_rid_.count(rid) != 0;
}

Mirror::Multimesh *Mirror::multimesh_for(std::uint64_t rid, const char *op, std::uint64_t frame,
                                         MultimeshCall *out) {
  if (!mm_options_.enabled) {
    return nullptr;
  }
  Multimesh *mm = find_multimesh(rid);
  if (mm == nullptr) {
    ++stats_.multimesh_unknown;
    return nullptr;
  }
  out->known = true;
  out->id = mm->id;
  out->version = mm->version;
  if (omit_op_matches(op, frame)) {
    ++stats_.dropped_omit_op;
    out->omitted = true;
    out->accepted = true;  // the engine still takes it; the mirror does not
    return nullptr;
  }
  return mm;
}

std::uint32_t Mirror::multimesh_stride(const Multimesh &mm) {
  return (mm.format == 1 ? 12u : 8u) + (mm.colors ? 4u : 0u) + (mm.custom ? 4u : 0u);
}

bool Mirror::multimesh_referenced(std::uint32_t id) const {
  for (const auto &entry : items_.all()) {
    for (const Command &command : entry.second.state.commands) {
      if (command.kind == CommandKind::AddMultimesh && command.multimesh == id) {
        return true;
      }
    }
  }
  return false;
}

void Mirror::multimesh_moved(Multimesh *mm, MultimeshCall *out) {
  ++epoch_;
  ++mm->version;
  out->changed = true;
  out->version = mm->version;
}

void Mirror::multimesh_buffer_moved(Multimesh *mm, std::uint64_t frame) {
  // stale-buffer (rule 11): the first multimesh whose buffer changes at or after the frame keeps
  // its serial from then on.
  if (mm_options_.stale_buffer_frame != 0 && frame >= mm_options_.stale_buffer_frame &&
      (stale_buffer_multimesh_ == 0 || stale_buffer_multimesh_ == mm->id)) {
    stale_buffer_multimesh_ = mm->id;
    return;
  }
  ++mm->buffer_serial;
}

std::vector<float> *Mirror::multimesh_writable(Multimesh *mm) {
  if (mm->buffer == nullptr) {
    return nullptr;
  }
  if (mm->buffer.use_count() > 1) {
    mm->buffer = std::make_shared<std::vector<float>>(*mm->buffer);  // a snapshot still holds it
  } else {
    // HC5: a snapshot's last holder may have let go on the encode thread (acq_rel); this orders
    // its reads before our writes.
    std::atomic_thread_fence(std::memory_order_acquire);
  }
  return mm->buffer.get();
}

bool Mirror::multimesh_patch(Multimesh *mm, std::int32_t index, std::uint32_t offset,
                             const float *values, std::uint32_t count, std::uint64_t frame) {
  if (mm->buffer == nullptr) {
    return true;  // payload-too-large keeps no shadow: every accepted call moves the version
  }
  const std::size_t at = static_cast<std::size_t>(index) * multimesh_stride(*mm) + offset;
  if (at + count > mm->buffer->size()) {
    return false;  // never: the index and the layout were checked
  }
  if (float_bits_equal(mm->buffer->data() + at, values, count)) {
    return false;
  }
  std::vector<float> *buffer = multimesh_writable(mm);
  std::memcpy(buffer->data() + at, values, count * sizeof(float));
  multimesh_buffer_moved(mm, frame);
  return true;
}

Mirror::MultimeshCall Mirror::multimesh_create(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  if (!mm_options_.enabled || rid == 0) {
    return out;
  }
  if (omit_op_matches("multimesh_create", frame)) {
    ++stats_.dropped_omit_op;
    out.omitted = true;
    out.accepted = true;
    return out;
  }
  const auto stale = multimesh_by_rid_.find(rid);
  if (stale != multimesh_by_rid_.end()) {
    // A recycled RID value: the old id leaves (a tombstone while named).
    MultimeshCall ignored;
    Multimesh &old = multimeshes_.at(stale->second);
    multimesh_by_rid_.erase(stale);
    old.rid = 0;
    old.freed = true;
    old.buffer.reset();
    multimesh_moved(&old, &ignored);
    if (!multimesh_referenced(old.id)) {
      note_multimesh(old, frame);
      multimeshes_.erase(old.id);
    }
  }
  ++epoch_;
  Multimesh mm;
  mm.id = next_multimesh_id_++;
  mm.rid = rid;
  mm.buffer = std::make_shared<std::vector<float>>();  // 0 instances: an empty buffer
  multimesh_by_rid_[rid] = mm.id;
  out.known = true;
  out.accepted = true;
  out.changed = true;
  out.id = mm.id;
  out.version = mm.version;
  multimeshes_.emplace(mm.id, std::move(mm));
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_allocate_data(std::uint64_t rid, std::int32_t instances,
                                                      std::int32_t format, bool colors, bool custom,
                                                      bool indirect, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_allocate_data", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  if (instances < 0 || (format != 0 && format != 1)) {
    ++stats_.multimesh_rejected;  // MultiMesh::set_instance_count refuses < 0; RS has two formats
    return out;
  }
  out.accepted = true;
  mm->indirect = indirect;
  mm->buffer_interpolated = false;  // rule 2: a re-allocate leaves multimesh-interpolated
  const bool same = mm->instances == instances && mm->format == format && mm->colors == colors &&
                    mm->custom == custom;
  if (!same) {
    // GLES3 _multimesh_allocate_data (mesh_storage.cpp:1536-1581): a new, unset buffer (reads back
    // as zeros, _multimesh_make_local), visible clamped with MIN; the custom AABB stays.
    mm->instances = instances;
    mm->format = format;
    mm->colors = colors;
    mm->custom = custom;
    mm->visible = std::min(mm->visible, mm->instances);
    const std::uint64_t floats =
        static_cast<std::uint64_t>(instances) * static_cast<std::uint64_t>(multimesh_stride(*mm));
    std::shared_ptr<std::vector<float>> before = std::move(mm->buffer);
    mm->too_large = floats * sizeof(float) > mm_options_.max_payload_bytes;
    if (!mm->too_large) {
      mm->buffer = std::make_shared<std::vector<float>>(static_cast<std::size_t>(floats), 0.0f);
    }
    const bool bytes_equal =
        before != nullptr && mm->buffer != nullptr && before->size() == mm->buffer->size() &&
        float_bits_equal(before->data(), mm->buffer->data(), before->size());
    if (!bytes_equal) {
      multimesh_buffer_moved(mm, frame);
    }
  }
  // GLES3 returns early on an identical shape (the buffer is kept); rule 2 moves the version of
  // every accepted allocate all the same.
  multimesh_moved(mm, &out);
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_set_mesh(std::uint64_t rid, std::uint64_t mesh_rid,
                                                 std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_set_mesh", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  out.accepted = true;
  // GLES3 _multimesh_set_mesh (:1589-1593): the same RID, or RID(), changes nothing.
  if (mesh_rid == 0 || mesh_rid == mm->mesh_rid) {
    ++stats_.multimesh_unchanged;
    return out;
  }
  mm->mesh_rid = mesh_rid;
  const Mesh *mesh = peek_mesh(mesh_rid);  // HC4b: a read, no mark
  mm->unknown_mesh = mesh == nullptr;
  mm->mesh_id = mesh != nullptr ? mesh->id : 0;
  multimesh_moved(mm, &out);
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_instance_set_transform(
    std::uint64_t rid, std::int32_t index, const std::array<float, 12> &transform,
    std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_instance_set_transform", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  if (index < 0 || index >= mm->instances || mm->format != 1) {
    ++stats_.multimesh_rejected;  // ERR_FAIL_INDEX, ERR_FAIL_COND(format != TRANSFORM_3D)
    return out;
  }
  out.accepted = true;
  if (multimesh_patch(mm, index, 0, transform.data(), 12, frame)) {
    multimesh_moved(mm, &out);
  } else {
    ++stats_.multimesh_unchanged;
  }
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_instance_set_transform_2d(std::uint64_t rid,
                                                                  std::int32_t index,
                                                                  const Xform &t,
                                                                  std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_instance_set_transform_2d", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  if (index < 0 || index >= mm->instances || mm->format != 0) {
    ++stats_.multimesh_rejected;  // ERR_FAIL_INDEX, ERR_FAIL_COND(format != TRANSFORM_2D)
    return out;
  }
  out.accepted = true;
  // GLES3 _multimesh_instance_set_transform_2d (:1769-1793): [xx, yx, 0, ox, xy, yy, 0, oy] with
  // Xform = (columns[0].x, columns[0].y, columns[1].x, columns[1].y, columns[2].x, columns[2].y).
  const float values[8] = {t[0], t[2], 0.0f, t[4], t[1], t[3], 0.0f, t[5]};
  if (multimesh_patch(mm, index, 0, values, 8, frame)) {
    multimesh_moved(mm, &out);
  } else {
    ++stats_.multimesh_unchanged;
  }
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_instance_set_color(std::uint64_t rid, std::int32_t index,
                                                           const Color4 &color,
                                                           std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_instance_set_color", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  if (index < 0 || index >= mm->instances || !mm->colors) {
    ++stats_.multimesh_rejected;  // ERR_FAIL_INDEX, ERR_FAIL_COND(!uses_colors)
    return out;
  }
  out.accepted = true;
  // set_buffer's layout: the colour right after the transform.
  const std::uint32_t at = mm->format == 1 ? 12u : 8u;
  if (multimesh_patch(mm, index, at, color.data(), 4, frame)) {
    multimesh_moved(mm, &out);
  } else {
    ++stats_.multimesh_unchanged;
  }
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_instance_set_custom_data(std::uint64_t rid,
                                                                 std::int32_t index,
                                                                 const Color4 &color,
                                                                 std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_instance_set_custom_data", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  if (index < 0 || index >= mm->instances || !mm->custom) {
    ++stats_.multimesh_rejected;  // ERR_FAIL_INDEX, ERR_FAIL_COND(!uses_custom_data)
    return out;
  }
  out.accepted = true;
  // set_buffer's layout: custom data after the colour (when colors).
  const std::uint32_t at = (mm->format == 1 ? 12u : 8u) + (mm->colors ? 4u : 0u);
  if (multimesh_patch(mm, index, at, color.data(), 4, frame)) {
    multimesh_moved(mm, &out);
  } else {
    ++stats_.multimesh_unchanged;
  }
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_set_custom_aabb(std::uint64_t rid,
                                                        const std::array<float, 6> &aabb,
                                                        std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_set_custom_aabb", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  out.accepted = true;
  if (float_bits_equal(mm->custom_aabb.data(), aabb.data(), 6)) {
    ++stats_.multimesh_unchanged;
    return out;
  }
  mm->custom_aabb = aabb;
  multimesh_moved(mm, &out);
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_set_buffer(std::uint64_t rid, const float *data,
                                                   std::size_t count, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_set_buffer", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  const std::uint64_t expected =
      static_cast<std::uint64_t>(mm->instances) * static_cast<std::uint64_t>(multimesh_stride(*mm));
  if (count != expected || (count != 0 && data == nullptr)) {
    ++stats_.multimesh_rejected;  // ERR_FAIL_COND(p_buffer.size() != instances * stride)
    return out;
  }
  out.accepted = true;
  if (mm->buffer == nullptr) {
    multimesh_moved(mm, &out);  // payload-too-large: no shadow to compare against
    return out;
  }
  if (float_bits_equal(mm->buffer->data(), data, count)) {
    ++stats_.multimesh_unchanged;  // an idle emitter re-sets its buffer: nothing moves
    return out;
  }
  if (mm->buffer.use_count() > 1) {
    mm->buffer = std::make_shared<std::vector<float>>(data, data + count);
  } else {
    std::atomic_thread_fence(std::memory_order_acquire);  // HC5: see multimesh_writable
    std::memcpy(mm->buffer->data(), data, count * sizeof(float));
  }
  multimesh_buffer_moved(mm, frame);
  multimesh_moved(mm, &out);
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_set_buffer_interpolated(std::uint64_t rid,
                                                                const float *data,
                                                                std::size_t count,
                                                                std::size_t prev_count,
                                                                std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_set_buffer_interpolated", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  // RendererMeshStorage::multimesh_set_buffer_interpolated (storage/mesh_storage.cpp:238-256):
  // both buffers must have the interpolator's size, instances x stride.
  const std::uint64_t expected =
      static_cast<std::uint64_t>(mm->instances) * static_cast<std::uint64_t>(multimesh_stride(*mm));
  if (count != expected || prev_count != expected || (count != 0 && data == nullptr)) {
    ++stats_.multimesh_rejected;
    return out;
  }
  out.accepted = true;
  mm->buffer_interpolated = true;
  if (mm->buffer != nullptr && !float_bits_equal(mm->buffer->data(), data, count)) {
    std::vector<float> *buffer = multimesh_writable(mm);
    std::memcpy(buffer->data(), data, count * sizeof(float));
    multimesh_buffer_moved(mm, frame);
  }
  multimesh_moved(mm, &out);  // rule 2: always
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_set_physics_interpolated(std::uint64_t rid,
                                                                 bool interpolated,
                                                                 std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_set_physics_interpolated", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  out.accepted = true;
  if (mm->physics_interpolated == interpolated) {
    ++stats_.multimesh_unchanged;
    return out;
  }
  mm->physics_interpolated = interpolated;
  multimesh_moved(mm, &out);
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_set_visible_instances(std::uint64_t rid,
                                                              std::int32_t visible,
                                                              std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "multimesh_set_visible_instances", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  // GLES3 _multimesh_set_visible_instances (:2139-2159).
  if (visible < -1 || visible > mm->instances) {
    ++stats_.multimesh_rejected;
    return out;
  }
  out.accepted = true;
  if (mm->visible == visible) {
    ++stats_.multimesh_unchanged;
    return out;
  }
  mm->visible = visible;
  multimesh_moved(mm, &out);
  return out;
}

Mirror::MultimeshCall Mirror::multimesh_free(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  MultimeshCall out;
  Multimesh *mm = multimesh_for(rid, "free", frame, &out);
  if (mm == nullptr) {
    return out;
  }
  out.accepted = true;
  multimesh_by_rid_.erase(rid);
  mm->rid = 0;
  mm->freed = true;
  mm->buffer.reset();
  multimesh_moved(mm, &out);  // rule 2: free always
  if (!multimesh_referenced(mm->id)) {
    note_multimesh(*mm, frame);  // its last state, before the entry leaves for good
    multimeshes_.erase(mm->id);
  }
  return out;
}

void Mirror::add_multimesh(std::uint64_t rid, std::uint64_t multimesh_rid, std::uint64_t texture,
                           std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_add_multimesh";
  Item *item = geometry_item(rid, kOp, frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  const Multimesh *mm = mm_options_.enabled ? find_multimesh(multimesh_rid) : nullptr;
  if (mm == nullptr) {
    // Rule 7: a multimesh the capture never saw created (or RID()).
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = mm_options_.enabled ? UnsupportedCmdReason::UnknownMultimesh
                                                     : UnsupportedCmdReason::UnsupportedOp;
  } else if (geometry_texture(texture, kOp, &command)) {
    command.kind = CommandKind::AddMultimesh;
    command.multimesh = mm->id;
  }
  push_command(item, std::move(command), frame);
}

MultimeshEntry Mirror::wire_multimesh(const Multimesh &mm) const {
  MultimeshEntry out;
  out.id = mm.id;
  out.version = mm.version;
  if (mm.freed) {
    out.status = MultimeshStatus::Freed;  // rule 2's tombstone: every other field its default
    return out;
  }
  out.has_mesh = mm.mesh_id != 0 && !mm.unknown_mesh;
  out.mesh = out.has_mesh ? mm.mesh_id : 0;
  out.format = mm.format == 1 ? MultimeshFormat::ThreeD : MultimeshFormat::TwoD;
  out.colors = mm.colors;
  out.custom = mm.custom;
  out.instances = mm.instances;
  out.visible = mm.visible;
  out.custom_aabb = mm.custom_aabb;
  // Rule 2's reasons, the first that applies.
  out.has_reason = true;
  if (mm.format == 1) {
    out.reason = MultimeshReason::Multimesh3d;
  } else if (mm.indirect) {
    out.reason = MultimeshReason::MultimeshIndirect;
  } else if (mm.physics_interpolated || mm.buffer_interpolated) {
    out.reason = MultimeshReason::MultimeshInterpolated;
  } else if (mm.unknown_mesh) {
    out.reason = MultimeshReason::UnknownMesh;
  } else if (mm.too_large || mm.buffer == nullptr) {
    out.reason = MultimeshReason::PayloadTooLarge;
  } else {
    out.has_reason = false;
  }
  if (out.has_reason) {
    out.status = MultimeshStatus::Unsupported;
    return out;
  }
  out.buffer = mm.buffer;
  out.buffer_serial = mm.buffer_serial;
  return out;
}

void Mirror::note_multimesh(const Multimesh &mm, std::uint64_t frame) {
  if (!mm_options_.state_notes || mm.noted_version == mm.version) {
    return;
  }
  MultimeshStateNote note;
  note.frame = frame;
  note.rid = mm.rid;
  note.entry = wire_multimesh(mm);
  note.shadow = mm.buffer;
  multimesh_notes_.push_back(std::move(note));
}

std::vector<Mirror::MultimeshStateNote> Mirror::take_multimesh_states() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<MultimeshStateNote> out;
  out.swap(multimesh_notes_);
  return out;
}

// --- particles (PM5; render-stream-12.md "Particles table", "The emit list") ------------------

namespace {

// GLES3's Particles struct defaults (drivers/gles3/storage/particles_storage.h): amount_ratio 1,
// lifetime 1, pre_process 0, explosiveness 0, randomness 0, speed_scale 1, collision_base_size
// 0.01, trail length 0, interp_to_end 0, request_process_time 0, custom AABB (-4,-4,-4, 8,8,8),
// emission transform identity, velocity 0. (golden-12's generator fills unlisted floats with
// collision_base_size 1; its states are explicit, so the goldens do not depend on this.)
std::shared_ptr<std::vector<float>> default_particle_floats() {
  return std::make_shared<std::vector<float>>(std::vector<float>{
      1.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.01f, 0.0f, 0.0f, 0.0f,         // 0-9
      -4.0f, -4.0f, -4.0f, 8.0f, 8.0f, 8.0f,                               // 10-15
      1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f,  // 16-27
      0.0f, 0.0f, 0.0f});                                                   // 28-30
}

}  // namespace

void Mirror::set_particles(const ParticlesOptions &options) {
  std::lock_guard<std::mutex> lock(mutex_);
  pt_options_ = options;
  pub_valid_ = false;  // HC4a: digests and flags depend on it; rebuild
}

Mirror::Particles *Mirror::find_particles(std::uint64_t rid) {
  if (rid == 0) {
    return nullptr;
  }
  const auto it = particles_by_rid_.find(rid);
  return it == particles_by_rid_.end() ? nullptr : &particles_.at(it->second);
}

bool Mirror::knows_particles(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  return rid != 0 && particles_by_rid_.count(rid) != 0;
}

std::uint32_t Mirror::material_id_of(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = material_by_rid_.find(rid);
  return rid == 0 || it == material_by_rid_.end() ? 0 : it->second;
}

std::uint32_t Mirror::mesh_id_of(std::uint64_t rid) const {
  std::lock_guard<std::mutex> lock(mutex_);
  const auto it = mesh_by_rid_.find(rid);
  return rid == 0 || it == mesh_by_rid_.end() ? 0 : it->second.id;
}

bool Mirror::particles_referenced(std::uint32_t id) const {
  for (const auto &entry : items_.all()) {
    for (const Command &command : entry.second.state.commands) {
      if (command.kind == CommandKind::AddParticles && command.particles == id) {
        return true;
      }
    }
  }
  for (const auto &entry : particles_) {
    if (!entry.second.freed && !entry.second.unknown_sub && entry.second.sub_id == id) {
      return true;
    }
  }
  return false;
}

void Mirror::particles_moved(Particles *p, ParticlesCall *out) {
  ++epoch_;
  ++ppm_epoch_;
  ++p->version;
  out->changed = true;
  out->version = p->version;
}

void Mirror::retire_particles(Particles *p, std::uint64_t frame) {
  ParticlesCall ignored;
  particles_by_rid_.erase(p->rid);
  p->rid = 0;
  p->freed = true;
  p->floats.reset();
  p->material_rid = 0;
  p->material_id = 0;
  p->unknown_material = false;
  p->pass_rids.clear();
  p->pass_ids.clear();
  p->pass_unknown.clear();
  p->sub_rid = 0;
  p->sub_id = 0;
  p->unknown_sub = false;
  particles_moved(p, &ignored);
  if (!particles_referenced(p->id)) {
    note_particles(*p, frame);  // its last state, before the entry leaves for good
    particles_.erase(p->id);
  }
}

Mirror::ParticlesCall Mirror::particles_create(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  ParticlesCall out;
  if (!pt_options_.enabled || rid == 0) {
    return out;
  }
  if (omit_op_matches("particles_create", frame)) {
    ++stats_.dropped_omit_op;
    out.omitted = true;
    out.accepted = true;
    return out;
  }
  if (Particles *stale = find_particles(rid)) {
    retire_particles(stale, frame);  // a recycled RID value: the old id leaves
  }
  ++epoch_;
  ++ppm_epoch_;
  Particles p;
  p.id = next_particles_id_++;
  p.rid = rid;
  p.floats = default_particle_floats();
  particles_by_rid_[rid] = p.id;
  out.known = true;
  out.accepted = true;
  out.changed = true;
  out.id = p.id;
  out.version = p.version;
  particles_.emplace(p.id, std::move(p));
  return out;
}

Mirror::ParticlesCall Mirror::particles_adopt(std::uint64_t rid, const ParticlesAdopt &a,
                                              std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  ParticlesCall out;
  if (!pt_options_.enabled || rid == 0 || particles_by_rid_.count(rid) != 0 ||
      a.floats.size() < kParticlesBaseFloats ||
      (a.floats.size() - kParticlesBaseFloats) % 12 != 0) {
    return out;
  }
  (void)frame;
  ++epoch_;
  ++ppm_epoch_;
  Particles p;
  p.id = next_particles_id_++;
  p.rid = rid;
  p.adopted = true;
  p.mode_2d = true;
  p.emitting = a.emitting;
  p.amount = a.amount;
  p.one_shot = a.one_shot;
  p.fixed_fps = a.fixed_fps;
  p.interpolate = a.interpolate;
  p.fractional_delta = a.fractional_delta;
  p.local = a.local;
  p.draw_order = a.draw_order;
  p.transform_align = a.transform_align;
  p.trails = a.trails;
  p.seed = a.seed;
  p.restarts = 1;  // the constructor's restart: a joiner's emitter starts fresh (PM6a rule 4)
  if (a.material != 0) {
    const auto it = material_by_rid_.find(a.material);
    p.material_rid = a.material;
    p.material_id = it != material_by_rid_.end() ? it->second : 0;
    p.unknown_material = it == material_by_rid_.end();
  }
  {
    const auto it = mesh_by_rid_.find(a.mesh);
    p.pass_rids.push_back(a.mesh);
    p.pass_ids.push_back(a.mesh != 0 && it != mesh_by_rid_.end() ? it->second.id : 0);
    p.pass_unknown.push_back(a.mesh != 0 && it == mesh_by_rid_.end());
  }
  if (a.subemitter != 0) {
    const auto it = particles_by_rid_.find(a.subemitter);
    if (it != particles_by_rid_.end()) {
      p.sub_rid = a.subemitter;
      p.sub_id = it->second;
    }
  }
  p.floats = std::make_shared<std::vector<float>>(a.floats);
  particles_by_rid_[rid] = p.id;
  out.known = true;
  out.accepted = true;
  out.changed = true;
  out.id = p.id;
  out.version = p.version;
  out.restarts = p.restarts;
  particles_.emplace(p.id, std::move(p));
  return out;
}

Mirror::ParticlesCall Mirror::particles_free(std::uint64_t rid, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  ParticlesCall out;
  if (!pt_options_.enabled) {
    return out;
  }
  Particles *p = find_particles(rid);
  if (p == nullptr) {
    ++stats_.particles_unknown;
    return out;
  }
  out.known = true;
  out.id = p->id;
  if (omit_op_matches("free", frame)) {
    ++stats_.dropped_omit_op;
    out.omitted = true;
    out.accepted = true;
    out.version = p->version;
    return out;
  }
  out.accepted = true;
  retire_particles(p, frame);
  out.changed = true;
  const auto it = particles_.find(out.id);
  out.version = it != particles_.end() ? it->second.version : 0;
  return out;
}

Mirror::ParticlesCall Mirror::particles_call(std::uint64_t rid, ParticlesOp op,
                                             const ParticlesArgs &args, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  ParticlesCall out;
  if (!pt_options_.enabled) {
    return out;
  }
  // RID arguments: their wire ids, for the hook log whether or not the call is accepted.
  if (op == ParticlesOp::SetProcessMaterial) {
    const auto it = material_by_rid_.find(args.rid);
    out.ref_id = args.rid != 0 && it != material_by_rid_.end() ? it->second : 0;
  } else if (op == ParticlesOp::SetDrawPassMesh) {
    const auto it = mesh_by_rid_.find(args.rid);
    out.ref_id = args.rid != 0 && it != mesh_by_rid_.end() ? it->second.id : 0;
  } else if (op == ParticlesOp::SetSubemitter) {
    const auto it = particles_by_rid_.find(args.rid);
    out.ref_id = args.rid != 0 && it != particles_by_rid_.end() ? it->second : 0;
  }
  Particles *p = find_particles(rid);
  if (p == nullptr) {
    ++stats_.particles_unknown;
    return out;
  }
  out.known = true;
  out.id = p->id;
  out.version = p->version;
  out.restarts = p->restarts;
  static const char *const kOpNames[] = {
      "particles_set_mode", "particles_set_emitting", "particles_set_amount",
      "particles_set_amount_ratio", "particles_set_lifetime", "particles_set_one_shot",
      "particles_set_pre_process_time", "particles_request_process_time",
      "particles_set_explosiveness_ratio", "particles_set_randomness_ratio",
      "particles_set_custom_aabb", "particles_set_speed_scale",
      "particles_set_use_local_coordinates", "particles_set_process_material",
      "particles_set_fixed_fps", "particles_set_interpolate", "particles_set_fractional_delta",
      "particles_set_collision_base_size", "particles_set_seed", "particles_set_transform_align",
      "particles_set_trails", "particles_set_trail_bind_poses", "particles_request_process",
      "particles_restart", "particles_set_subemitter", "particles_emit",
      "particles_set_draw_order", "particles_set_draw_passes", "particles_set_draw_pass_mesh",
      "particles_set_emission_transform", "particles_set_emitter_velocity",
      "particles_set_interp_to_end"};
  if (omit_op_matches(kOpNames[static_cast<int>(op)], frame)) {
    ++stats_.dropped_omit_op;
    out.omitted = true;
    out.accepted = true;
    return out;
  }
  // The float slots a setter writes (offset, count); count 0 for a non-float setter.
  std::size_t at = 0;
  std::size_t count = 0;
  bool changed = false;
  const auto set_bool = [&](bool *field) {
    const bool v = args.i != 0;
    changed = *field != v;
    *field = v;
  };
  const auto set_int = [&](std::int32_t *field) {
    const std::int32_t v = static_cast<std::int32_t>(args.i);
    changed = *field != v;
    *field = v;
  };
  out.accepted = true;
  switch (op) {
    case ParticlesOp::SetMode: {
      const bool v = args.i == 0;  // RS::PARTICLES_MODE_2D
      changed = p->mode_2d != v;
      p->mode_2d = v;
      break;
    }
    case ParticlesOp::SetEmitting: set_bool(&p->emitting); break;
    case ParticlesOp::SetAmount: set_int(&p->amount); break;
    case ParticlesOp::SetOneShot: set_bool(&p->one_shot); break;
    case ParticlesOp::SetUseLocalCoordinates: set_bool(&p->local); break;
    case ParticlesOp::SetFixedFps: set_int(&p->fixed_fps); break;
    case ParticlesOp::SetInterpolate: set_bool(&p->interpolate); break;
    case ParticlesOp::SetFractionalDelta: set_bool(&p->fractional_delta); break;
    case ParticlesOp::SetTransformAlign: set_int(&p->transform_align); break;
    case ParticlesOp::SetDrawOrder: set_int(&p->draw_order); break;
    case ParticlesOp::SetSeed: {
      const std::uint32_t v = static_cast<std::uint32_t>(args.i);
      changed = p->seed != v;
      p->seed = v;
      break;
    }
    case ParticlesOp::SetAmountRatio: at = 0; count = 1; break;
    case ParticlesOp::SetLifetime: at = 1; count = 1; break;
    case ParticlesOp::SetPreProcessTime: at = 2; count = 1; break;
    case ParticlesOp::SetExplosivenessRatio: at = 3; count = 1; break;
    case ParticlesOp::SetRandomnessRatio: at = 4; count = 1; break;
    case ParticlesOp::SetSpeedScale: at = 5; count = 1; break;
    case ParticlesOp::SetCollisionBaseSize: at = 6; count = 1; break;
    case ParticlesOp::SetInterpToEnd: at = 8; count = 1; break;
    case ParticlesOp::SetCustomAabb: at = 10; count = 6; break;
    case ParticlesOp::SetEmissionTransform: at = 16; count = 12; break;
    case ParticlesOp::SetEmitterVelocity: at = 28; count = 3; break;
    case ParticlesOp::RequestProcessTime:
      at = 9;
      count = 1;
      ++p->process_requests;
      changed = true;  // always: the counter moves
      break;
    case ParticlesOp::SetTrails: {
      const bool v = args.i != 0;
      changed = p->trails != v;
      p->trails = v;
      at = 7;
      count = 1;
      break;
    }
    case ParticlesOp::SetTrailBindPoses: {
      const std::size_t poses = args.f.size() / 12;
      std::vector<float> next(p->floats->begin(), p->floats->begin() + static_cast<long>(kParticlesBaseFloats));
      next.insert(next.end(), args.f.begin(), args.f.begin() + static_cast<long>(poses * 12));
      if (next.size() != p->floats->size() ||
          std::memcmp(next.data(), p->floats->data(), next.size() * sizeof(float)) != 0) {
        p->floats = std::make_shared<std::vector<float>>(std::move(next));
        changed = true;
      }
      break;
    }
    case ParticlesOp::RequestProcess:
      break;  // accepted; nothing the entry carries changes
    case ParticlesOp::Restart:
      if (pt_options_.drop_restart_frame != 0 && frame >= pt_options_.drop_restart_frame &&
          !drop_restart_done_) {
        // Sabotage drop-restart: counted in the host's state (the hook log), not on the wire.
        drop_restart_done_ = true;
        ++p->restarts_dropped;
        ++p->wire_version_skew;
      }
      if (pt_options_.drop_events_frame != 0 && frame >= pt_options_.drop_events_frame) {
        // Sabotage freeze-drop-events (FRZ-P): from the frame on, every restart is dropped on the
        // wire (the hook log keeps the true count), so the frozen seat's burst cannot be replayed.
        ++p->restarts_dropped;
        ++p->wire_version_skew;
      }
      ++p->restarts;
      changed = true;
      break;
    case ParticlesOp::Emit: {
      ++p->emits;
      changed = true;
      if (pt_options_.drop_events_frame != 0 && frame >= pt_options_.drop_events_frame) {
        // Sabotage freeze-drop-events: the emit never reaches the emit log (the wire), so the
        // frozen seat's emitted particles are missing from the replay.
        ++p->emits_dropped;
        ++p->wire_version_skew;
        out.restarts = p->restarts;
        break;
      }
      rs2::ParticleEmit e;
      e.particles = p->id;
      e.restarts = p->restarts - p->restarts_dropped;
      e.flags = args.flags;
      for (std::size_t k = 0; k < e.floats.size() && k < args.f.size(); ++k) {
        e.floats[k] = args.f[k];
      }
      pending_emits_.push_back(e);
      out.restarts = p->restarts;
      break;
    }
    case ParticlesOp::SetProcessMaterial: {
      const std::uint32_t id = out.ref_id;
      const bool unknown = args.rid != 0 && id == 0;
      changed = p->material_rid != args.rid || p->material_id != id || p->unknown_material != unknown;
      p->material_rid = args.rid;
      p->material_id = id;
      p->unknown_material = unknown;
      ++ppm_epoch_;
      break;
    }
    case ParticlesOp::SetSubemitter: {
      const std::uint32_t id = out.ref_id;
      const bool unknown = args.rid != 0 && id == 0;
      changed = p->sub_rid != args.rid || p->sub_id != id || p->unknown_sub != unknown;
      p->sub_rid = args.rid;
      p->sub_id = id;
      p->unknown_sub = unknown;
      break;
    }
    case ParticlesOp::SetDrawPasses: {
      if (args.i < 0) {
        out.accepted = false;  // Vector::resize refuses a negative size
        break;
      }
      const std::size_t n = static_cast<std::size_t>(args.i);
      changed = p->pass_rids.size() != n;
      p->pass_rids.resize(n, 0);
      p->pass_ids.resize(n, 0);
      p->pass_unknown.resize(n, false);
      break;
    }
    case ParticlesOp::SetDrawPassMesh: {
      if (args.i < 0 || static_cast<std::size_t>(args.i) >= p->pass_rids.size()) {
        out.accepted = false;  // ERR_FAIL_INDEX
        break;
      }
      const std::size_t k = static_cast<std::size_t>(args.i);
      const std::uint32_t id = out.ref_id;
      const bool unknown = args.rid != 0 && id == 0;
      changed = p->pass_rids[k] != args.rid || p->pass_ids[k] != id || p->pass_unknown[k] != unknown;
      p->pass_rids[k] = args.rid;
      p->pass_ids[k] = id;
      p->pass_unknown[k] = unknown;
      break;
    }
  }
  if (count != 0 && args.f.size() >= count) {
    float *dst = nullptr;
    if (std::memcmp(p->floats->data() + at, args.f.data(), count * sizeof(float)) != 0) {
      if (p->floats.use_count() > 1) {
        p->floats = std::make_shared<std::vector<float>>(*p->floats);  // a note still holds it
      } else {
        std::atomic_thread_fence(std::memory_order_acquire);  // HC5: see multimesh_writable
      }
      dst = p->floats->data() + at;
      std::memcpy(dst, args.f.data(), count * sizeof(float));
      changed = true;
    }
  }
  if (out.accepted && changed) {
    particles_moved(p, &out);
  }
  if (op == ParticlesOp::Emit) {
    out.restarts = p->restarts;
  }
  return out;
}

void Mirror::add_particles(std::uint64_t rid, std::uint64_t particles_rid, std::uint64_t texture,
                           std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  static const char kOp[] = "canvas_item_add_particles";
  Item *item = geometry_item(rid, kOp, frame);
  if (item == nullptr) {
    return;
  }
  Command command;
  const Particles *p = pt_options_.enabled ? find_particles(particles_rid) : nullptr;
  if (p == nullptr) {
    command.kind = CommandKind::Unsupported;
    command.name = kOp;
    command.unsupported_reason = pt_options_.enabled ? UnsupportedCmdReason::UnknownParticles
                                                     : UnsupportedCmdReason::UnsupportedOp;
  } else if (geometry_texture(texture, kOp, &command)) {
    command.kind = CommandKind::AddParticles;
    command.particles = p->id;
  }
  ++ppm_epoch_;
  push_command(item, std::move(command), frame);
}

ParticlesEntry Mirror::wire_particles(const Particles &p, bool notes) const {
  ParticlesEntry out;
  out.id = p.id;
  out.origin = p.adopted ? Origin::Adopted : Origin::Created;
  out.version = notes ? p.version : p.version - p.wire_version_skew;
  out.mode_2d = p.mode_2d;
  out.emitting = p.emitting;
  out.amount = p.amount;
  out.one_shot = p.one_shot;
  out.fixed_fps = p.fixed_fps;
  out.interpolate = p.interpolate;
  out.fractional_delta = p.fractional_delta;
  out.local = p.local;
  out.draw_order = p.draw_order;
  out.transform_align = p.transform_align;
  out.trails = p.trails;
  out.seed = p.seed;
  out.restarts = notes ? p.restarts : p.restarts - p.restarts_dropped;
  out.emits = notes ? p.emits : p.emits - p.emits_dropped;
  out.process_requests = p.process_requests;
  if (p.freed) {
    out.status = ParticlesStatus::Freed;
    out.trail_poses = 0;
    return out;
  }
  out.floats = p.floats;
  out.trail_poses =
      p.floats != nullptr && p.floats->size() > kParticlesBaseFloats
          ? static_cast<std::uint32_t>((p.floats->size() - kParticlesBaseFloats) / 12)
          : 0;
  if (!p.trails && out.trail_poses > 0) {
    // particles-entry: trail poses need trails. GLES3 keeps bind poses set while trails are off
    // but never uses them, so the wire (and the hook log's state line) carries none until trails
    // turn on; the poses come back with them, because the mirror keeps them.
    out.floats = std::make_shared<const std::vector<float>>(
        p.floats->begin(), p.floats->begin() + kParticlesBaseFloats);
    out.trail_poses = 0;
  }
  out.process_material = p.unknown_material ? 0 : p.material_id;
  out.draw_passes.reserve(p.pass_ids.size());
  bool unknown_mesh = false;
  for (std::size_t k = 0; k < p.pass_ids.size(); ++k) {
    unknown_mesh = unknown_mesh || p.pass_unknown[k];
    out.draw_passes.push_back(p.pass_unknown[k] ? 0 : p.pass_ids[k]);
  }
  out.subemitter = p.unknown_sub ? 0 : p.sub_id;
  out.has_reason = true;
  if (!p.mode_2d) {
    out.reason = ParticlesReason::Particles3d;
  } else if (p.unknown_material) {
    out.reason = ParticlesReason::UnknownMaterial;
  } else if (unknown_mesh) {
    out.reason = ParticlesReason::UnknownMesh;
  } else if (p.unknown_sub) {
    out.reason = ParticlesReason::UnknownParticles;
  } else {
    out.has_reason = false;
  }
  out.status = out.has_reason ? ParticlesStatus::Unsupported : ParticlesStatus::Ok;
  return out;
}

void Mirror::note_particles(const Particles &p, std::uint64_t frame) {
  if (!pt_options_.state_notes || p.noted_version == p.version) {
    return;
  }
  ParticlesStateNote note;
  note.frame = frame;
  note.rid = p.rid;
  note.entry = wire_particles(p, true);
  particles_notes_.push_back(std::move(note));
}

std::vector<Mirror::ParticlesStateNote> Mirror::take_particles_states() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<ParticlesStateNote> out;
  out.swap(particles_notes_);
  return out;
}

std::uint64_t Mirror::ppm_epoch() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return ppm_epoch_;
}

std::vector<Mirror::PpmCandidate> Mirror::ppm_candidates() const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<PpmCandidate> out;
  if (!pt_options_.enabled) {
    return out;
  }
  // The items drawing each emitter id.
  std::map<std::uint32_t, std::vector<std::uint64_t>> drawn_by;
  for (const auto &entry : items_.all()) {
    for (const Command &command : entry.second.state.commands) {
      if (command.kind == CommandKind::AddParticles) {
        drawn_by[command.particles].push_back(entry.second.rid);
      }
    }
  }
  std::map<std::uint32_t, std::size_t> index;  // shader id -> out index
  for (const auto &entry : particles_) {
    const Particles &p = entry.second;
    if (p.freed || p.material_id == 0 || p.unknown_material) {
      continue;
    }
    const auto items = drawn_by.find(p.id);
    if (items == drawn_by.end()) {
      continue;
    }
    const auto material = materials_.all().find(p.material_id);
    if (material == materials_.all().end() || !material->second.has_shader) {
      continue;
    }
    const auto shader = shaders_.all().find(material->second.shader);
    if (shader == shaders_.all().end() || shader->second.has_ppm || !shader->second.has_code ||
        shader->second.copy.mode != "particles") {
      continue;
    }
    auto at = index.find(shader->first);
    if (at == index.end()) {
      at = index.emplace(shader->first, out.size()).first;
      PpmCandidate c;
      c.shader_rid = shader->second.rid;
      out.push_back(std::move(c));
    }
    for (std::uint64_t item : items->second) {
      out[at->second].pairs.emplace_back(p.material_rid, item);
    }
  }
  return out;
}

void Mirror::set_shader_ppm(std::uint64_t shader_rid,
                            const rs2::BuiltinParticleProcessMaterial &key) {
  std::lock_guard<std::mutex> lock(mutex_);
  Shader *shader = find_shader(shader_rid);
  if (shader == nullptr || (shader->has_ppm && shader->ppm == key)) {
    return;
  }
  shader->has_ppm = true;
  shader->ppm = key;
  ++shader->version;
  ++stats_.ppm_resolved;
  ++epoch_;
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
  for (const auto &entry : items_.all()) {
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
  for (auto &entry : textures_.unmarked()) {
    Texture &texture = entry.second;
    if (texture.job != nullptr) {
      texture.job->wait();  // G8kw: the sabotage re-copies bytes, so it needs them
      settle(&texture);
    }
    if (texture.kind == TextureKind::Image && texture.status == TextureStatus::Ok &&
        texture.rid != 0 && texture.bytes != nullptr) {
      textures_.mark(entry.first, &texture);  // HC4b
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
  shaders_.mut(id)->rid = new_rid;
}

void Mirror::set_shader_policy(ShaderPolicy policy) {
  std::lock_guard<std::mutex> lock(mutex_);
  ++epoch_;
  shader_policy_ = policy;
  pub_valid_ = false;  // HC4b: every shader entry depends on it; rebuild
}

void Mirror::set_perturb_shader(std::uint64_t from_frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  perturb_shader_frame_ = from_frame;
}

Mirror::Shader *Mirror::find_shader(std::uint64_t rid) {
  const auto it = shader_by_rid_.find(rid);
  return it == shader_by_rid_.end() ? nullptr : shaders_.mut(it->second);  // HC4b: marks
}

Mirror::Material *Mirror::find_material(std::uint64_t rid) {
  const auto it = material_by_rid_.find(rid);
  return it == material_by_rid_.end() ? nullptr : materials_.mut(it->second);  // HC4b: marks
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

bool Mirror::reads_time(const Shader &shader) const {
  if (shader.refused || !shader.has_code || shader.copy.status != "ok") {
    return false;
  }
  ShaderMode mode = ShaderMode::CanvasItem;
  if (!shader_mode_from_text(shader.copy.mode, &mode)) {
    return false;
  }
  if (!shader.copy.builtin && shader_policy_ == ShaderPolicy::Exclude) {
    return false;
  }
  return std::find(shader.copy.uses.begin(), shader.copy.uses.end(), "time") !=
         shader.copy.uses.end();
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
  if (shader.has_ppm && pt_options_.enabled && mode == ShaderMode::Particles) {
    // PM5 (render-stream-12.md "Effect"): a particles-mode shader keyed by the
    // particle_process_material builtin is `ok` at /12, its code never withheld or excluded;
    // below /12 it is what it was (below_v12).
    const auto below = std::make_shared<const ShaderEntry>(out);
    out.status = ShaderStatus::Ok;
    out.has_reason = false;
    out.source = ShaderSource::Payload;
    out.has_ppm = true;
    out.ppm = shader.ppm;
    out.below_v12 = below;
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
  const MaterialStatus status = out.status;
  out.params = wire.params;
  if (wire.unsupported && out.status == MaterialStatus::Ok) {
    out.status = MaterialStatus::Unsupported;
    out.has_reason = true;
    out.reason = wire.reason;
  }
  if (wire.has_below) {
    // PM5: what a connection below /12 sees (the Array parameter refused, as before PM5).
    MaterialEntry below = out;
    below.status = status;
    below.has_reason = material.shader_unknown;
    below.reason = MaterialReason::UnknownShader;
    below.params = wire.below_params;
    if (wire.below_unsupported && below.status == MaterialStatus::Ok) {
      below.status = MaterialStatus::Unsupported;
      below.has_reason = true;
      below.reason = wire.below_reason;
    }
    out.below_v12 = std::make_shared<const MaterialEntry>(std::move(below));
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
  // PM5: /12 carries a plain Array parameter's packed form (v12_ok); the /11 form is kept apart.
  wire.has_below = false;
  for (const auto &entry : material.params) {
    if (entry.second.v12_ok) {
      wire.has_below = true;
      break;
    }
  }
  std::vector<Param> below_params;
  wire.below_unsupported = false;
  wire.below_reason = MaterialReason::ParamType;
  for (const auto &entry : material.params) {
    const MaterialParam &param = entry.second;
    if (wire.has_below) {
      if (param.ok) {
        below_params.push_back(param.param);
      } else if (!wire.below_unsupported) {
        wire.below_unsupported = true;
        wire.below_reason = param.reason;
      }
    }
    if (wire.has_below && param.v12_ok) {
      params.push_back(param.v12_param);
    } else if (param.ok) {
      params.push_back(param.param);
      if (param.param.has_tex) {
        wire.textures.push_back(param.param.tex);
      }
    } else if (!wire.unsupported) {
      wire.unsupported = true;
      wire.reason = param.reason;
    }
  }
  wire.below_params = std::move(below_params);
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
    const Item *found = items_.find(parent.id);
    if (found == nullptr) {
      break;
    }
    const ItemState &p = found->state;
    material = p.has_material ? p.material : 0;
    if (!p.use_parent_material) {
      break;
    }
    parent = p.parent;
  }
  return material;
}

bool Mirror::material_unsupported(std::uint32_t material_id) const {
  const auto it = materials_.all().find(material_id);
  if (it == materials_.all().end()) {
    return false;
  }
  const Material &material = it->second;
  const auto texture_unsupported = [this](std::uint32_t tex) {
    const auto t = textures_.all().find(tex);
    return t != textures_.all().end() &&
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
    const auto s = shaders_.all().find(material.shader);
    if (s != shaders_.all().end()) {
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
  if (!param.ok && pt_options_.param_arrays && value.type == "array" && value.array_form) {
    // PM5: the packed form GLES3 converts the Array to, carried at /12 (wire_params()).
    DecodedParam packed;
    packed.type = value.array_type;
    packed.packed = true;
    packed.n = value.array_n;
    packed.f = value.array_f;
    MaterialReason ignored = MaterialReason::ParamType;
    param.v12_ok = to_param(name, packed, &param.v12_param, &ignored);
  }
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
  // HC1: setting the material the item already holds gives the adoption pass nothing new, so it
  // leaves the epoch (and everything else) alone. A set that changes nothing is also what the
  // lines below would rebuild identically.
  if (material != 0) {
    const auto held = material_by_rid_.find(material);
    if (held != material_by_rid_.end()
            ? (item->state.has_material && item->state.material == held->second &&
               !item->unknown_material)
            : (item->unknown_material && item->unknown_material_rid == material &&
               !item->state.has_material)) {
      return;
    }
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

void Mirror::set_canvas_group_mode(std::uint64_t rid, std::int32_t mode, float clear_margin,
                                   bool fit_empty, float fit_margin, bool blur_mipmaps,
                                   std::uint64_t frame) {
  if (mode < 0 || mode > 3) {
    return;  // render-stream-10.md "Capture": unreachable from scene code; the hook counts it
  }
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_canvas_group_mode", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_canvas_group_mode", frame)) {
    // renderer_canvas_cull.cpp:2015-2033: DISABLED frees the group (nothing of the call is kept);
    // any other mode replaces the whole state.
    CanvasGroupState group;
    if (mode != 0) {
      group.mode = static_cast<CanvasGroupMode>(mode);
      group.clear_margin = clear_margin;
      group.fit_empty = fit_empty;
      group.fit_margin = fit_margin;
      group.blur_mipmaps = blur_mipmaps;
    }
    item->state.canvas_group = group;
  }
}

void Mirror::set_copy_to_backbuffer(std::uint64_t rid, bool enable, const Rect4 &rect,
                                    std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (dropped("canvas_item_set_copy_to_backbuffer", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_copy_to_backbuffer", frame)) {
    // renderer_canvas_cull.cpp:1871-1886: disabling frees the copy (the rect is not kept).
    item->state.copy_to_backbuffer = enable;
    item->state.copy_to_backbuffer_rect = enable ? rect : kZeroRect;
  }
}

void Mirror::set_use_identity_transform(std::uint64_t rid, bool enable, std::uint64_t frame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (const Item *known = peek_item(rid);
      known != nullptr && known->state.use_identity_transform == enable) {
    // A call that changes nothing moves no epoch: CPUParticles2D's constructor sends false to
    // every emitter, a local one included, and that must not publish a frame.
    return;
  }
  if (dropped("canvas_item_set_use_identity_transform", frame)) {
    return;
  }
  if (Item *item = item_for(rid, "canvas_item_set_use_identity_transform", frame)) {
    item->state.use_identity_transform = enable;
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
    const Item *found = items_.find(child);
    if (found == nullptr) {
      continue;
    }
    const ItemState &state = found->state;
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

// --- HC4a (host-cost-design.md D1): the persistent published item and canvas state ---------------

namespace {

bool refs_equal(const std::vector<UnsupportedRef> &a, const std::vector<UnsupportedRef> &b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (a[i].op != b[i].op || a[i].has_item != b[i].has_item || a[i].item != b[i].item ||
        a[i].reason != b[i].reason) {
      return false;
    }
  }
  return true;
}

// The item-level order (render-stream-2.md "Item-level unsupported entries"): item id, then op,
// then reason (byte order).
bool item_level_before(const UnsupportedRef &a, const UnsupportedRef &b) {
  if (a.item != b.item) {
    return a.item < b.item;
  }
  if (a.op != b.op) {
    return a.op < b.op;
  }
  return std::string(to_wire(a.reason)) < std::string(to_wire(b.reason));
}

UnsupportedRef tie_entry(std::uint32_t item) {
  UnsupportedRef ref;
  ref.op = "canvas_item_set_draw_index";
  ref.has_item = true;
  ref.item = item;
  ref.reason = UnsupportedReason::DrawIndexTie;
  return ref;
}

}  // namespace

void Mirror::set_hc_shadow(bool on, ProtocolVersion version) {
  std::lock_guard<std::mutex> lock(mutex_);
  hc_shadow_ = on;
  hc_shadow_version_ = version;
  hc_shadow_failure_.clear();
  hc_shadow_have_prev_ = false;
  hc_shadow_prev_ = Snapshot();
  hc_shadow_prev_full_ = Snapshot();
  hc_shadow_prev_captured_ = Captured();
}

std::string Mirror::hc_shadow_failure() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return hc_shadow_failure_;
}

bool Mirror::hc_shadow_enabled() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return hc_shadow_;
}

std::string Mirror::hc_sabotage() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return items_.skip_dirty_      ? "hc-skip-dirty"
         : hc_stale_derived_      ? "hc-stale-derived"
         : textures_.skip_dirty_  ? "hc-skip-dirty-texture"
                                  : "";
}

void Mirror::set_default_hc_shadow(bool on) { g_default_hc_shadow.store(on); }

std::uint64_t Mirror::hc_shadow_mismatches_total() { return g_hc_shadow_mismatches.load(); }

void Mirror::set_inline_max(std::uint64_t inline_max_bytes) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (inline_max_ != inline_max_bytes) {
    inline_max_ = inline_max_bytes;
    pub_valid_ = false;  // HC4b: the inline counts depend on it; rebuild
  }
}

void Mirror::set_hc_sabotage_texture(bool skip_dirty_texture) {
  std::lock_guard<std::mutex> lock(mutex_);
  textures_.skip_dirty_ = skip_dirty_texture;
  textures_.skip_id_ = 0;
}

void Mirror::set_hc_sabotage(bool skip_dirty, bool stale_derived) {
  std::lock_guard<std::mutex> lock(mutex_);
  items_.skip_dirty_ = skip_dirty;
  hc_stale_derived_ = stale_derived;
  hc_stale_derived_used_ = false;
}

bool Mirror::texture_entry_unsupported(std::uint32_t id) const {
  // render-stream-2.md "Item-level unsupported entries": the command's own tex is unsupported (or
  // G8kf delivery-pending), or (G2d) it names a canvas entry whose diffuse is.
  const auto texture = textures_.all().find(id);
  if (texture == textures_.all().end()) {
    return false;
  }
  if (texture->second.status == TextureStatus::Unsupported || pending_ids_.count(id) != 0) {
    return true;
  }
  if (texture->second.kind == TextureKind::Canvas && texture->second.has_diffuse) {
    const auto diffuse = textures_.all().find(texture->second.diffuse_id);
    return diffuse != textures_.all().end() &&
           (diffuse->second.status == TextureStatus::Unsupported ||
            pending_ids_.count(texture->second.diffuse_id) != 0);
  }
  return false;
}

void Mirror::own_entries(const Item &item, std::map<std::uint32_t, bool> *memo,
                         std::vector<UnsupportedRef> *out) const {
  // One entry per distinct (op, reason) pair of the item: an unsupported command's name and
  // reason, a texture draw naming an unsupported texture (unsupported-texture), an unsupported
  // mesh, multimesh or emitter, a material (unsupported-state, unknown-material,
  // unsupported-material), a param-type instance parameter, a skeleton.
  const std::size_t begin = out->size();
  const ItemState &state = item.state;
  const auto add = [out, begin, &state](const std::string &op, UnsupportedReason reason) {
    for (std::size_t i = begin; i < out->size(); ++i) {
      const UnsupportedRef &ref = (*out)[i];
      if (ref.has_item && ref.item == state.id && ref.op == op && ref.reason == reason) {
        return;
      }
    }
    UnsupportedRef ref;
    ref.op = op;
    ref.has_item = true;
    ref.item = state.id;
    ref.reason = reason;
    out->push_back(std::move(ref));
  };
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
      } else if (command.unsupported_reason == UnsupportedCmdReason::UnknownMultimesh) {
        reason = UnsupportedReason::UnknownMultimesh;  // PM1 rule 7
      } else if (command.unsupported_reason == UnsupportedCmdReason::UnknownParticles) {
        reason = UnsupportedReason::UnknownParticles;  // PM5 "The command"
      }
      add(command.name, reason);
    } else if (names_texture(command) && command.has_tex) {
      if (texture_entry_unsupported(command.tex)) {
        add(rs_method_name(command.kind), UnsupportedReason::UnsupportedTexture);
      }
    }
    if (command.kind == CommandKind::AddMesh) {
      // render-stream-4.md "Command": an add_mesh naming an `unsupported` mesh entry.
      const auto mesh = meshes_.all().find(command.mesh);
      if (mesh != meshes_.all().end() && mesh->second.status == MeshStatus::Unsupported) {
        add("canvas_item_add_mesh", UnsupportedReason::UnsupportedMesh);
      }
    } else if (command.kind == CommandKind::AddMultimesh) {
      // PM1 rule 7: an add_multimesh naming an `unsupported` multimesh entry (a tombstone is
      // not unsupported).
      const auto mm = multimeshes_.find(command.multimesh);
      if (mm != multimeshes_.end() &&
          wire_multimesh(mm->second).status == MultimeshStatus::Unsupported) {
        add("canvas_item_add_multimesh", UnsupportedReason::UnsupportedMultimesh);
      }
    } else if (command.kind == CommandKind::AddParticles) {
      // PM5: an add_particles naming an `unsupported` emitter (a tombstone adds none).
      const auto pt = particles_.find(command.particles);
      if (pt != particles_.end() &&
          wire_particles(pt->second, false).status == ParticlesStatus::Unsupported) {
        add("canvas_item_add_particles", UnsupportedReason::UnsupportedParticles);
      }
    }
  }
  // G55d (render-stream-5.md "Derived item-level entries"): at most one canvas_item_set_material
  // entry per item -- an unknown material RID, else an unsupported effective material (D9) --
  // and one canvas_item_set_instance_shader_parameter param-type entry.
  if (item.unknown_material) {
    add("canvas_item_set_material", UnsupportedReason::UnknownMaterial);
  } else {
    const std::uint32_t effective = effective_material(item);
    if (effective != 0) {
      // P3-CAP: once per material per snapshot (nothing it reads changes under the lock).
      auto verdict = memo->find(effective);
      if (verdict == memo->end()) {
        verdict = memo->emplace(effective, material_unsupported(effective)).first;
      }
      if (verdict->second) {
        add("canvas_item_set_material", UnsupportedReason::UnsupportedMaterial);
      }
    }
  }
  if (!item.instance_param_unsupported.empty()) {
    add("canvas_item_set_instance_shader_parameter", UnsupportedReason::ParamType);
  }
  if (item.unsupported_skeleton) {
    add("canvas_item_attach_skeleton", UnsupportedReason::UnsupportedState);
  }
}

void Mirror::refresh_cv(Item *item) {
  if (!v11_.enabled || v11_.cv_churn) {
    return;
  }
  // W11b: the stable content_version, recomputed only when the item recorded something since
  // (its counter moved). HC2 (host-cost-design.md D1): a re-record equal to the published list
  // is not a change -- it publishes that very list (shared with the snapshots that hold it) and
  // keeps its digest, with no encode and no SHA-256.
  Item &held = *item;
  if (held.cv_digest_set && held.cv_digest_of == held.state.content_version) {
    return;
  }
  const SharedVector<Command> &now = held.state.commands;
  const bool same =
      held.cv_digest_set &&
      (now.shares(held.cv_commands) ||
       (v11_.rerecord_stale ? same_command_kinds(now.vector(), held.cv_commands.vector())
                            : command_lists_equal_bits(now.vector(), held.cv_commands.vector())));
  if (same) {
    if (!now.shares(held.cv_commands)) {
      held.spare_commands = std::move(held.state.commands);  // no snapshot holds it yet
    }
    held.state.commands = held.cv_commands;
    ++stats_.cv_rerecords_kept;
  } else {
    held.cv_digest = command_list_digest(now.vector());
    // PM1: what a connection below /11 sees of a list with multimesh commands (rs2_diff.h
    // lower_multimesh): the digest of the lowered list, as before PM1.
    held.cv_digest_below = 0;
    held.cv_digest_below12 = 0;
    std::vector<Command> lowered;
    if (pt_options_.enabled) {
      // PM5: /11's view (particles lowered) and /10's (both lowered).
      if (lower_particles_commands(now.vector(), &lowered)) {
        held.cv_digest_below12 = command_list_digest(lowered);
      }
      if (lower_v11_commands(now.vector(), &lowered)) {
        held.cv_digest_below = command_list_digest(lowered);
      }
    } else if (mm_options_.enabled && lower_multimesh_commands(now.vector(), &lowered)) {
      held.cv_digest_below = command_list_digest(lowered);
    }
    held.cv_commands = now;
    ++stats_.cv_digests;
  }
  held.cv_digest_of = held.state.content_version;
  held.cv_digest_set = true;
}

void Mirror::stamp_cv(const Item &item, ItemState *state) const {
  if (v11_.enabled && !v11_.cv_churn) {
    state->content_version = item.cv_digest;
    state->content_version_below_v11 = item.cv_digest_below;
    state->content_version_below_v12 = item.cv_digest_below12;
  }
}

void Mirror::stamp_cv_fresh(const Item &item, ItemState *state) const {
  if (!v11_.enabled || v11_.cv_churn) {
    return;
  }
  if (item.cv_digest_set && item.cv_digest_of == item.state.content_version) {
    stamp_cv(item, state);
    return;
  }
  // refresh_cv's decision, computed without touching the item's cache.
  const SharedVector<Command> &now = item.state.commands;
  const bool same =
      item.cv_digest_set &&
      (now.shares(item.cv_commands) ||
       (v11_.rerecord_stale ? same_command_kinds(now.vector(), item.cv_commands.vector())
                            : command_lists_equal_bits(now.vector(), item.cv_commands.vector())));
  if (same) {
    state->commands = item.cv_commands;
    stamp_cv(item, state);
    return;
  }
  state->content_version = command_list_digest(now.vector());
  state->content_version_below_v11 = 0;
  state->content_version_below_v12 = 0;
  std::vector<Command> lowered;
  if (pt_options_.enabled) {
    if (lower_particles_commands(now.vector(), &lowered)) {
      state->content_version_below_v12 = command_list_digest(lowered);
    }
    if (lower_v11_commands(now.vector(), &lowered)) {
      state->content_version_below_v11 = command_list_digest(lowered);
    }
  } else if (mm_options_.enabled && lower_multimesh_commands(now.vector(), &lowered)) {
    state->content_version_below_v11 = command_list_digest(lowered);
  }
}

void Mirror::publish_items(const std::set<std::uint32_t> &withheld, ItemsPublished *out) {
  ItemMap::Map &map = items_.unmarked();
  const bool full = !pub_valid_ || items_.all_dirty_;
  // 1. The items to visit: those marked since the last snapshot, those erased, and those entering
  // or leaving a withheld subtree; every item when the whole table moved.
  std::vector<std::uint32_t> visit;
  if (full) {
    ++stats_.hc_full_rebuilds;
    pub_items_.clear();
    pub_canvases_.clear();
    pub_.clear();
    item_ties_.clear();
    canvas_ties_.clear();
    tie_count_.clear();
    level_.clear();
    item_level_.clear();
    mm_refs_.clear();
    pt_refs_.clear();
    mm_command_items_ = 0;
    pt_command_items_ = 0;
    material_users_.clear();
    mm_verdicts_.clear();
    pt_verdicts_.clear();
    material_verdicts_.clear();
    visit.reserve(map.size());
    for (auto &entry : map) {
      entry.second.dirty = false;
      visit.push_back(entry.first);
    }
  } else {
    visit.reserve(items_.dirty_.size() + items_.gone_.size());
    for (std::uint32_t id : items_.dirty_) {
      const auto it = map.find(id);
      if (it != map.end()) {
        it->second.dirty = false;
      }
      visit.push_back(id);
    }
    visit.insert(visit.end(), items_.gone_.begin(), items_.gone_.end());
    if (withheld != withheld_prev_) {
      std::set_symmetric_difference(withheld.begin(), withheld.end(), withheld_prev_.begin(),
                                    withheld_prev_.end(), std::back_inserter(visit));
    }
    std::sort(visit.begin(), visit.end());
    visit.erase(std::unique(visit.begin(), visit.end()), visit.end());
  }
  stats_.hc_dirty_marks_dropped = items_.dropped_;
  items_.dirty_.clear();
  items_.gone_.clear();
  items_.all_dirty_ = false;
  pub_valid_ = true;
  if (withheld != withheld_prev_) {
    withheld_prev_ = withheld;
  }
  stats_.hc_items_visited += visit.size();

  const auto live = [&map, &withheld](std::uint32_t id) -> Item * {
    const auto it = map.find(id);
    return it != map.end() && withheld.count(id) == 0 ? &it->second : nullptr;
  };
  std::vector<std::uint32_t> derive;  // items whose own entries may have changed
  std::set<std::uint32_t> tie_items;  // containers whose draw-index ties may have changed
  std::set<std::uint32_t> tie_canvases;
  const auto container = [&tie_items, &tie_canvases](const ParentRef &parent) {
    if (parent.kind == ParentKind::Item) {
      tie_items.insert(parent.id);
    } else if (parent.kind == ParentKind::Canvas) {
      tie_canvases.insert(parent.id);
    }
  };
  const auto uncount = [this](PubItem *pub) {
    if (!pub->counted) {
      return;
    }
    for (std::uint32_t id : pub->multimeshes) {
      const auto it = mm_refs_.find(id);
      if (--it->second == 0) {
        mm_refs_.erase(it);
      }
    }
    for (std::uint32_t id : pub->particles) {
      const auto it = pt_refs_.find(id);
      if (--it->second == 0) {
        pt_refs_.erase(it);
      }
    }
    mm_command_items_ -= pub->multimesh_command ? 1 : 0;
    pt_command_items_ -= pub->particles_command ? 1 : 0;
    pub->multimeshes.clear();
    pub->particles.clear();
    pub->multimesh_command = false;
    pub->particles_command = false;
    pub->counted = false;
  };

  // 2. Each visited item: its published entry (republished only when it really differs), its
  // references, and the containers and items whose derived parts it can move.
  for (std::uint32_t id : visit) {
    Item *item = live(id);
    const auto found = pub_.find(id);
    PubItem *pub = found != pub_.end() ? &found->second : nullptr;
    const ItemState *old = pub_items_.find(id);
    if (old != nullptr) {
      container(old->parent);
    }
    tie_items.insert(id);
    derive.push_back(id);
    if (pub != nullptr) {
      uncount(pub);
    }
    if (item == nullptr) {
      if (old != nullptr) {
        pub_items_.erase(id);
        ++stats_.hc_items_republished;
      }
      continue;
    }
    if (pub == nullptr) {
      pub = &pub_[id];
    }
    refresh_cv(item);
    ItemState state = item->state;
    stamp_cv(*item, &state);
    container(state.parent);
    if (old == nullptr || item_state_difference(*old, state) != nullptr) {
      pub_items_.set(std::move(state));
      ++stats_.hc_items_republished;
    }
    item->published = true;
    for (const Command &command : item->state.commands) {
      if (command.kind == CommandKind::AddMultimesh) {
        pub->multimeshes.push_back(command.multimesh);
        ++mm_refs_[command.multimesh];
      } else if (command.kind == CommandKind::AddParticles) {
        pub->particles.push_back(command.particles);
        ++pt_refs_[command.particles];
      }
      if (command.kind == CommandKind::AddMultimesh ||
          (command.kind == CommandKind::Unsupported && command.name == "canvas_item_add_multimesh")) {
        pub->multimesh_command = true;
      }
      if (command.kind == CommandKind::AddParticles ||
          (command.kind == CommandKind::Unsupported && command.name == "canvas_item_add_particles")) {
        pub->particles_command = true;
      }
    }
    mm_command_items_ += pub->multimesh_command ? 1 : 0;
    pt_command_items_ += pub->particles_command ? 1 : 0;
    pub->counted = true;
    // D9: what decides the effective material of this item and of every descendant that uses its
    // parent's material. When it moved, those descendants' entries are rederived too.
    const ItemState &now = item->state;
    const std::array<std::uint32_t, 5> key = {
        now.has_material ? now.material + 1u : 0u, now.use_parent_material ? 1u : 0u,
        static_cast<std::uint32_t>(now.parent.kind), now.parent.id,
        item->unknown_material ? 1u : 0u};
    if (!pub->has_material_key || pub->material_key != key) {
      pub->has_material_key = true;
      pub->material_key = key;
      std::vector<std::uint32_t> stack(now.children.begin(), now.children.end());
      for (std::size_t steps = 0; !stack.empty() && steps <= map.size(); ++steps) {
        const std::uint32_t child = stack.back();
        stack.pop_back();
        const Item *c = items_.find(child);
        if (c == nullptr || !c->state.use_parent_material) {
          continue;
        }
        derive.push_back(child);
        stack.insert(stack.end(), c->state.children.begin(), c->state.children.end());
      }
    }
  }

  // 3. The inputs other items' entries read. A texture or mesh turning unsupported (or back), or
  // a referenced multimesh's, emitter's or effective material's verdict moving, rederives every
  // item: rare, and cheaper than keeping reverse dependencies.
  // HC4b: the snapshot compared the marked textures' and meshes' inputs before this call
  // (hc_inputs_moved_), instead of a walk over both tables.
  bool all = full || hc_inputs_moved_;
  std::vector<std::uint32_t> derived;
  const auto derive_list = [&]() {
    derived = derive;
    if (all) {
      derived.reserve(derived.size() + map.size());
      for (const auto &entry : map) {
        derived.push_back(entry.first);
      }
    }
    std::sort(derived.begin(), derived.end());
    derived.erase(std::unique(derived.begin(), derived.end()), derived.end());
  };
  // Each rederived item's effective material, counted per material.
  const auto count_materials = [&]() {
    for (std::uint32_t id : derived) {
      const Item *item = live(id);
      const std::uint32_t effective =
          item != nullptr && !item->unknown_material ? effective_material(*item) : 0;
      auto found = pub_.find(id);
      if (found == pub_.end()) {
        if (effective == 0) {
          continue;
        }
        found = pub_.emplace(id, PubItem()).first;
      }
      PubItem &pub = found->second;
      if (pub.material == effective) {
        continue;
      }
      if (pub.material != 0) {
        const auto it = material_users_.find(pub.material);
        if (--it->second == 0) {
          material_users_.erase(it);
        }
      }
      if (effective != 0) {
        ++material_users_[effective];
      }
      pub.material = effective;
    }
  };
  derive_list();
  count_materials();
  {
    // Each referenced id's verdict, updated in place (no per-snapshot map); an id no longer
    // referenced leaves its map.
    bool moved = false;
    const auto update = [&moved](std::map<std::uint32_t, bool> *verdicts,
                                 const std::map<std::uint32_t, std::uint32_t> &refs,
                                 const auto &verdict_of) {
      for (const auto &entry : refs) {
        const bool bad = verdict_of(entry.first);
        const auto placed = verdicts->emplace(entry.first, bad);
        if (!placed.second && placed.first->second != bad) {
          moved = true;
          placed.first->second = bad;
        }
      }
      if (verdicts->size() != refs.size()) {
        for (auto it = verdicts->begin(); it != verdicts->end();) {
          it = refs.count(it->first) == 0 ? verdicts->erase(it) : std::next(it);
        }
      }
    };
    update(&mm_verdicts_, mm_refs_, [this](std::uint32_t id) {
      const auto mm = multimeshes_.find(id);
      return mm != multimeshes_.end() &&
             wire_multimesh(mm->second).status == MultimeshStatus::Unsupported;
    });
    update(&pt_verdicts_, pt_refs_, [this](std::uint32_t id) {
      const auto pt = particles_.find(id);
      return pt != particles_.end() &&
             wire_particles(pt->second, false).status == ParticlesStatus::Unsupported;
    });
    // HC4b: a material's verdict reads only the material, its shader and textures (and the
    // pending set, which moves only with a visited texture), so it is recomputed only in a
    // snapshot that visited one of them.
    if (full || hc_verdict_inputs_moved_) {
      update(&material_verdicts_, material_users_,
             [this](std::uint32_t id) { return material_unsupported(id); });
    } else if (!materials_.dirty_.empty() || !materials_.gone_.empty()) {
      // Only materials moved: only their own verdicts can.
      const auto one = [&](std::uint32_t id) {
        const auto verdict = material_verdicts_.find(id);
        if (material_users_.count(id) == 0) {
          if (verdict != material_verdicts_.end()) {
            material_verdicts_.erase(verdict);
          }
          return;
        }
        const bool bad = material_unsupported(id);
        if (verdict == material_verdicts_.end()) {
          material_verdicts_.emplace(id, bad);
        } else if (verdict->second != bad) {
          moved = true;
          verdict->second = bad;
        }
      };
      for (std::uint32_t id : materials_.dirty_) {
        one(id);
      }
      for (std::uint32_t id : materials_.gone_) {
        one(id);
      }
    }
    if (moved && !all) {
      all = true;
      derive_list();
      count_materials();
    }
  }
  // own_entries' material verdicts: those of every effective material in use (an item rederived
  // below names one of them; a miss is computed and kept until the next update prunes it).
  std::map<std::uint32_t, bool> &memo = material_verdicts_;
  if (all) {
    ++stats_.hc_derived_all;
  }

  // 4. The own item-level entries of every rederived item.
  std::vector<std::uint32_t> buckets;  // items whose list of entries may have changed
  for (std::uint32_t id : derived) {
    std::vector<UnsupportedRef> own;
    if (const Item *item = live(id)) {
      own_entries(*item, &memo, &own);
    }
    auto found = pub_.find(id);
    if (found == pub_.end()) {
      if (own.empty()) {
        continue;
      }
      found = pub_.emplace(id, PubItem()).first;
    }
    if (refs_equal(found->second.own, own)) {
      continue;
    }
    if (hc_stale_derived_ && !hc_stale_derived_used_) {
      hc_stale_derived_used_ = true;  // hc-stale-derived: this item keeps its stale entries
      continue;
    }
    found->second.own = std::move(own);
    buckets.push_back(id);
  }

  // 5. Canvases (a handful: compared whole), then the draw-index ties of every container a
  // visited item or a changed canvas can move (render-stream-1.md "Invariant 9").
  for (const auto &entry : canvases_) {
    const CanvasState *old = pub_canvases_.find(entry.first);
    if (old == nullptr || canvas_state_difference(*old, entry.second.state) != nullptr) {
      pub_canvases_.set(entry.second.state);
      tie_canvases.insert(entry.first);
    }
  }
  {
    std::vector<std::uint32_t> removed;
    for (const CanvasState &canvas : pub_canvases_) {
      if (canvases_.count(canvas.id) == 0) {
        removed.push_back(canvas.id);
      }
    }
    for (std::uint32_t id : removed) {
      pub_canvases_.erase(id);
      tie_canvases.insert(id);
    }
  }
  const auto retie = [this, &buckets](std::vector<std::uint32_t> *cached,
                                      const std::vector<UnsupportedRef> &ties) {
    std::vector<std::uint32_t> reps;
    reps.reserve(ties.size());
    for (const UnsupportedRef &ref : ties) {
      reps.push_back(ref.item);
    }
    if (*cached == reps) {
      return;
    }
    for (std::uint32_t rep : *cached) {
      const auto it = tie_count_.find(rep);
      if (--it->second == 0) {
        tie_count_.erase(it);
      }
      buckets.push_back(rep);
    }
    for (std::uint32_t rep : reps) {
      ++tie_count_[rep];
      buckets.push_back(rep);
    }
    cached->swap(reps);
  };
  std::vector<UnsupportedRef> ties;
  for (std::uint32_t id : tie_items) {
    ties.clear();
    if (const Item *item = live(id)) {
      find_ties(item->state.children, &ties);
    }
    const auto found = item_ties_.find(id);
    if (found == item_ties_.end() && ties.empty()) {
      continue;
    }
    std::vector<std::uint32_t> &cached = found != item_ties_.end() ? found->second : item_ties_[id];
    retie(&cached, ties);
    if (cached.empty()) {
      item_ties_.erase(id);
    }
  }
  for (std::uint32_t id : tie_canvases) {
    ties.clear();
    const auto canvas = canvases_.find(id);
    if (canvas != canvases_.end()) {
      find_ties(canvas->second.state.items, &ties);
    }
    const auto found = canvas_ties_.find(id);
    if (found == canvas_ties_.end() && ties.empty()) {
      continue;
    }
    std::vector<std::uint32_t> &cached =
        found != canvas_ties_.end() ? found->second : canvas_ties_[id];
    retie(&cached, ties);
    if (cached.empty()) {
      canvas_ties_.erase(id);
    }
  }

  // 6. Each item's entries (its own and the ties naming it, in item-level order), and the
  // concatenation, rebuilt only when one of them changed.
  std::sort(buckets.begin(), buckets.end());
  buckets.erase(std::unique(buckets.begin(), buckets.end()), buckets.end());
  bool level_changed = full;
  for (std::uint32_t id : buckets) {
    std::vector<UnsupportedRef> bucket;
    const auto pub = pub_.find(id);
    if (pub != pub_.end()) {
      bucket = pub->second.own;
    }
    const auto count = tie_count_.find(id);
    for (std::uint32_t k = 0; count != tie_count_.end() && k < count->second; ++k) {
      bucket.push_back(tie_entry(id));
    }
    std::sort(bucket.begin(), bucket.end(), item_level_before);
    const auto held = level_.find(id);
    if (bucket.empty()) {
      if (held != level_.end()) {
        level_.erase(held);
        level_changed = true;
      }
    } else if (held == level_.end() || !refs_equal(held->second, bucket)) {
      level_[id] = std::move(bucket);
      level_changed = true;
    }
  }
  if (level_changed) {
    item_level_.clear();
    for (const auto &entry : level_) {
      item_level_.insert(item_level_.end(), entry.second.begin(), entry.second.end());
    }
  }
  // An erased item leaves nothing behind.
  for (std::uint32_t id : visit) {
    if (map.count(id) == 0) {
      const auto pub = pub_.find(id);
      if (pub != pub_.end() && pub->second.own.empty() && !pub->second.counted &&
          pub->second.material == 0) {
        pub_.erase(pub);
      }
    }
  }

  for (const auto &entry : mm_refs_) {
    out->multimeshes.insert(out->multimeshes.end(), entry.first);
  }
  for (const auto &entry : pt_refs_) {
    out->particles.insert(out->particles.end(), entry.first);
  }
  out->multimesh_commands = mm_options_.enabled && mm_command_items_ != 0;
  out->particles_commands = pt_options_.enabled && pt_command_items_ != 0;
}

void Mirror::full_walk_items(const std::set<std::uint32_t> &withheld, FullWalk *out) const {
  // The items walk as every snapshot ran it before HC4a (P3-CAP's single walk): the published
  // items with their content_version, the item-level entries and draw-index ties sorted, the
  // multimeshes and emitters the published items name and the lowering flags.
  std::map<std::uint32_t, bool> memo;
  out->items.reserve(items_.size());
  for (const auto &entry : items_.all()) {
    if (withheld.count(entry.first) != 0) {
      continue;
    }
    const Item &item = entry.second;
    ItemState state = item.state;
    stamp_cv_fresh(item, &state);
    own_entries(item, &memo, &out->item_level);
    find_ties(item.state.children, &out->item_level);
    for (const Command &command : state.commands) {
      if (command.kind == CommandKind::AddMultimesh) {
        out->refs.multimeshes.insert(command.multimesh);
      } else if (command.kind == CommandKind::AddParticles) {
        out->refs.particles.insert(command.particles);
      }
      if (pt_options_.enabled &&
          (command.kind == CommandKind::AddParticles ||
           (command.kind == CommandKind::Unsupported && command.name == "canvas_item_add_particles"))) {
        out->refs.particles_commands = true;
      }
      if (mm_options_.enabled &&
          (command.kind == CommandKind::AddMultimesh ||
           (command.kind == CommandKind::Unsupported && command.name == "canvas_item_add_multimesh"))) {
        out->refs.multimesh_commands = true;
      }
    }
    out->items.push_back(std::move(state));
  }
  for (const auto &entry : canvases_) {
    find_ties(entry.second.state.items, &out->item_level);
    out->canvases.push_back(entry.second.state);
  }
  std::sort(out->item_level.begin(), out->item_level.end(), item_level_before);
}

void Mirror::full_walk_resources(FullWalk *out) const {
  // The resource half of every snapshot as it was built before HC4b: every texture, mesh, shader
  // and material entry rebuilt, the payload map filled in table order (the first entry naming a
  // hash supplies its bytes), and the name index counted over the entries.
  const auto count_name = [out](const std::string &hash, std::uint64_t bytes, bool variant) {
    NameCount &count = out->names[hash];
    if (count.main == 0 && count.variant == 0) {
      count.payload_bytes = bytes;
    }
    ++(variant ? count.variant : count.main);
  };
  for (const auto &entry : textures_.all()) {
    const Texture &texture = entry.second;
    if (pending_ids_.count(entry.first) != 0) {
      Texture shown = texture;
      shown.status = TextureStatus::Unsupported;
      shown.has_reason = true;
      shown.reason = TextureReason::DeliveryPending;
      out->textures.push_back(wire_entry(shown));
    } else {
      out->textures.push_back(wire_entry(texture));
      if (texture.kind == TextureKind::Image && texture.status == TextureStatus::Ok &&
          texture.bytes != nullptr) {
        out->payloads.emplace(texture.copy.hash, texture.bytes);
        for (const rs2::TextureVariant &variant : out->textures.back().variants) {
          if (variant.hash == texture.copy.block_hash && texture.copy.block_bytes != nullptr) {
            out->payloads.emplace(variant.hash, texture.copy.block_bytes);
          } else if (variant.hash == texture.uastc_hash && texture.uastc_bytes != nullptr) {
            out->payloads.emplace(variant.hash, texture.uastc_bytes);
          }
        }
      } else if (texture.job != nullptr && texture.kind == TextureKind::Image &&
                 texture.status == TextureStatus::Ok) {
        out->jobs.push_back(entry.first);
      }
    }
    texture_entry_names(out->textures.back(), count_name);
  }
  for (const auto &entry : meshes_.all()) {
    std::vector<std::pair<std::string, PayloadPtr>> pairs;
    out->meshes.push_back(wire_mesh_peek(entry.second, &pairs));
    for (auto &pair : pairs) {
      out->payloads.emplace(pair.first, std::move(pair.second));
    }
    for (const MeshSurface &surface : out->meshes.back().surfaces) {
      out->keyed_surfaces = out->keyed_surfaces || surface.hash_is_key;
    }
    mesh_entry_names(out->meshes.back(), count_name);
  }
  for (const auto &entry : shaders_.all()) {
    const Shader &shader = entry.second;
    ShaderEntry wire = wire_shader(shader);
    if (carry_shader_time_ && wire.status == ShaderStatus::Ok &&
        std::find(wire.uses.begin(), wire.uses.end(), ShaderUse::Time) != wire.uses.end()) {
      out->time_read = true;
    }
    if (wire.status == ShaderStatus::Ok && wire.has_source &&
        wire.source == ShaderSource::Payload && wire.has_hash && shader.bytes != nullptr) {
      out->payloads.emplace(wire.hash, shader.bytes);
    }
    out->below_v12 = out->below_v12 || wire.below_v12 != nullptr;
    shader_entry_names(wire, count_name);
    out->shaders.push_back(std::move(wire));
  }
  for (const auto &entry : materials_.all()) {
    out->materials.push_back(wire_material(entry.second));
    out->below_v12 = out->below_v12 || out->materials.back().below_v12 != nullptr;
  }
}

void Mirror::shadow_compare(const FullWalk &walk, const ItemsPublished &refs, Captured *captured) {
  Snapshot *out = &captured->state;
  ++stats_.hc_shadow_checked;
  std::string diff;
  if (walk.withheld_differs) {
    diff = "withheld: the items left out differ from the full walk's";
  }
  if (diff.empty() && walk.items.size() != out->items.size()) {
    diff = "items: " + u64(out->items.size()) + " entries, the full walk " + u64(walk.items.size());
  }
  std::size_t i = 0;
  for (auto it = out->items.begin(); diff.empty() && it != out->items.end(); ++it, ++i) {
    if (it->id != walk.items[i].id) {
      diff = "items id " + u64(it->id) + ": the full walk has id " + u64(walk.items[i].id) + " there";
    } else if (const char *field = item_state_difference(walk.items[i], *it)) {
      diff = "items id " + u64(it->id) + ": " + field;
    }
  }
  if (diff.empty() && walk.canvases.size() != out->canvases.size()) {
    diff = "canvases: " + u64(out->canvases.size()) + " entries, the full walk " +
           u64(walk.canvases.size());
  }
  i = 0;
  for (auto it = out->canvases.begin(); diff.empty() && it != out->canvases.end(); ++it, ++i) {
    if (const char *field = canvas_state_difference(walk.canvases[i], *it)) {
      diff = "canvases id " + u64(it->id) + ": " + field;
    }
  }
  if (diff.empty() && !refs_equal(walk.item_level, item_level_)) {
    std::size_t k = 0;
    while (k < walk.item_level.size() && k < item_level_.size() &&
           refs_equal({walk.item_level[k]}, {item_level_[k]})) {
      ++k;
    }
    const UnsupportedRef &at = k < walk.item_level.size() ? walk.item_level[k] : item_level_[k];
    diff = "unsupported id " + u64(at.item) + ": " + at.op + " (" + u64(item_level_.size()) +
           " item-level entries, the full walk " + u64(walk.item_level.size()) + ")";
  }
  if (diff.empty() && walk.refs.multimeshes != refs.multimeshes) {
    diff = "multimeshes: the items' references differ";
  }
  if (diff.empty() && walk.refs.particles != refs.particles) {
    diff = "particles: the items' references differ";
  }
  if (diff.empty() && (walk.refs.multimesh_commands != refs.multimesh_commands ||
                       walk.refs.particles_commands != refs.particles_commands)) {
    diff = "flags: multimesh_commands/particles_commands differ";
  }
  // HC4b: the resource tables entry by entry, the payload map, the name index and the flags they
  // derive.
  const auto compare_table = [&diff](const char *name, const auto &table, const auto &walked,
                                     const auto &difference) {
    if (!diff.empty()) {
      return;
    }
    if (walked.size() != table.size()) {
      diff = std::string(name) + ": " + u64(table.size()) + " entries, the full walk " +
             u64(walked.size());
      return;
    }
    std::size_t k = 0;
    for (auto it = table.begin(); it != table.end(); ++it, ++k) {
      if (const char *field = difference(walked[k], *it)) {
        diff = std::string(name) + " id " + u64(it->id) + ": " + field;
        return;
      }
    }
  };
  compare_table("textures", out->textures, walk.textures, texture_entry_difference);
  compare_table("meshes", out->meshes, walk.meshes, mesh_entry_difference);
  compare_table("shaders", out->shaders, walk.shaders, shader_entry_difference);
  compare_table("materials", out->materials, walk.materials, material_entry_difference);
  if (diff.empty()) {
    if (captured->payloads.size() != walk.payloads.size()) {
      diff = "payloads: " + u64(captured->payloads.size()) + " hashes, the full walk " +
             u64(walk.payloads.size());
    } else {
      auto w = walk.payloads.begin();
      for (auto it = captured->payloads.begin(); it != captured->payloads.end(); ++it, ++w) {
        const bool same_bytes =
            it->second == w->second ||
            (it->second != nullptr && w->second != nullptr && *it->second == *w->second);
        if (it->first != w->first || !same_bytes) {
          diff = "payloads hash " + it->first.substr(0, 16) + ": differs from the full walk's " +
                 w->first.substr(0, 16);
          break;
        }
      }
    }
  }
  if (diff.empty() && captured->payloads.weight() != [&walk]() {
        std::uint64_t total = 0;
        for (const auto &entry : walk.payloads) {
          total += entry.second != nullptr ? entry.second->size() : 0;
        }
        return total;
      }()) {
    diff = "payloads: the map's byte total differs from the full walk's";
  }
  if (diff.empty()) {
    std::uint64_t inline_main = 0;
    std::uint64_t inline_any = 0;
    for (const auto &entry : walk.names) {
      const NameCount &c = entry.second;
      inline_main += c.main != 0 && c.payload_bytes <= inline_max_ ? 1 : 0;
      inline_any += c.payload_bytes <= inline_max_ ? 1 : 0;
      const NameIndex::value_type *found = captured->names.find_entry(entry.first);
      if (found == nullptr || found->second.main != c.main ||
          found->second.variant != c.variant || found->second.payload_bytes != c.payload_bytes) {
        diff = "names hash " + entry.first.substr(0, 16) + ": the index counts differ";
        break;
      }
    }
    if (diff.empty() && captured->names.size() != walk.names.size()) {
      diff = "names: " + u64(captured->names.size()) + " hashes, the full walk " +
             u64(walk.names.size());
    }
    if (diff.empty() && (captured->inline_count != inline_main ||
                         captured->inline_count_variants != inline_any)) {
      diff = "names: the inline counts differ (" + u64(captured->inline_count) + ", the full walk " +
             u64(inline_main) + ")";
    }
  }
  if (diff.empty()) {
    std::vector<std::uint32_t> jobs;
    for (const PendingTexture &p : captured->pending) {
      jobs.push_back(p.index < out->textures.size() ? out->textures[p.index].id : 0);
    }
    if (jobs != walk.jobs) {
      diff = "pending: the textures a worker holds differ";
    } else if (captured->keyed_surfaces != walk.keyed_surfaces) {
      diff = "flags: keyed_surfaces differs";
    } else if (out->shader_time.has_value() != walk.time_read) {
      diff = "flags: shader_time differs";
    } else if (out->particles_commands !=
               (walk.refs.particles_commands || walk.below_v12)) {
      diff = "flags: particles_commands (resources) differs";
    }
  }
  // The full walk's snapshot: this one with its items, canvases and item-level entries replaced
  // (fresh entries, so make_patch compares every one of them field by field).
  Snapshot full = *out;
  full.items = SharedTable<ItemState>(walk.items);
  full.canvases = SharedTable<CanvasState>(walk.canvases);
  full.textures = SharedTable<TextureEntry>(walk.textures);
  full.meshes = SharedTable<MeshEntry>(walk.meshes);
  full.shaders = SharedTable<ShaderEntry>(walk.shaders);
  full.materials = SharedTable<MaterialEntry>(walk.materials);
  full.unsupported.resize(out->unsupported.size() - item_level_.size());
  full.unsupported.insert(full.unsupported.end(), walk.item_level.begin(), walk.item_level.end());
  if (diff.empty()) {
    TxMeta meta;
    meta.version = hc_shadow_version_;
    meta.seq = out->seq;
    meta.frame = out->frame;
    std::vector<std::uint8_t> a;
    std::vector<std::uint8_t> b;
    if (hc_shadow_have_prev_) {
      meta.base_seq = hc_shadow_prev_.seq;
      a = encode_transaction(make_patch(hc_shadow_prev_, *out, meta));
      b = encode_transaction(make_patch(hc_shadow_prev_full_, full, meta));
    } else {
      a = encode_transaction(make_full(*out, meta));
      b = encode_transaction(make_full(full, meta));
    }
    if (a != b) {
      diff = "patch: the encoded transactions differ (" + u64(a.size()) + " bytes, the full walk's " +
             u64(b.size()) + ")";
    }
  }
  if (diff.empty()) {
    // HC4b: the /11 record plan over the differing entries equals records_before's full walk,
    // with and without texture variants.
    for (const bool variants : {false, true}) {
      InlinePolicy policy;
      policy.inline_max_bytes = inline_max_;
      policy.inline_variants = variants;
      const Captured *base = hc_shadow_have_prev_ ? &hc_shadow_prev_captured_ : nullptr;
      const RecordPlan plan = plan_v11_records(base, *captured, policy);
      const std::vector<PayloadName> want =
          records_before(base != nullptr ? &base->state : nullptr, *out, policy);
      bool same = plan.records.size() == want.size() &&
                  plan.inline_count == inline_names(*out, policy).size();
      for (std::size_t k = 0; same && k < want.size(); ++k) {
        same = plan.records[k].hash == want[k].hash &&
               plan.records[k].payload_bytes == want[k].payload_bytes;
      }
      if (!same) {
        diff = std::string("records: the plan over the differing entries differs from the full "
                           "walk's (") +
               u64(plan.records.size()) + " records, the full walk " + u64(want.size()) +
               (variants ? ", with variants)" : ")");
        break;
      }
    }
  }
  hc_shadow_prev_ = *out;
  hc_shadow_prev_full_ = std::move(full);
  hc_shadow_prev_captured_ = *captured;
  hc_shadow_have_prev_ = true;
  if (!diff.empty()) {
    ++stats_.hc_shadow_mismatches;
    g_hc_shadow_mismatches.fetch_add(1);
    if (hc_shadow_failure_.empty()) {
      hc_shadow_failure_ = diff + " at frame " + u64(out->frame);
      log_line("hc-shadow-mismatch: " + hc_shadow_failure_);
    }
  }
}

void Mirror::res_clear() {
  pub_textures_.clear();
  pub_meshes_.clear();
  pub_shaders_.clear();
  pub_materials_.clear();
  tex_share_.clear();
  mesh_share_.clear();
  shader_share_.clear();
  pub_payloads_.clear();
  payload_users_.clear();
  pub_names_.clear();
  inline_count_ = 0;
  inline_count_variants_ = 0;
  tex_jobbed_.clear();
  keyed_meshes_.clear();
  time_shaders_.clear();
  below_v12_shaders_.clear();
  below_v12_materials_.clear();
  tex_tombstones_.clear();
  mesh_tombstones_.clear();
  tex_key_.clear();
  bad_meshes_.clear();
  tex_recheck_.clear();
  pending_ids_.clear();
  textures_.published_.clear();
  res_dynamic_readers_ = dynamic_hashes_read();
  textures_.mut_all();
  meshes_.mut_all();
  shaders_.mut_all();
  materials_.mut_all();
}

void Mirror::res_names_add(const ResName &name, int delta) {
  const auto *found = pub_names_.find_entry(name.hash);
  NameCount count = found != nullptr ? found->second : NameCount();
  const NameCount before = count;
  if (count.main == 0 && count.variant == 0) {
    count.payload_bytes = name.payload_bytes;
  }
  std::uint32_t &slot = name.variant ? count.variant : count.main;
  slot = delta > 0 ? slot + 1 : slot - std::min<std::uint32_t>(slot, 1);
  const auto inline_main = [this](const NameCount &c) {
    return c.main != 0 && c.payload_bytes <= inline_max_;
  };
  const auto inline_any = [this](const NameCount &c) {
    return (c.main != 0 || c.variant != 0) && c.payload_bytes <= inline_max_;
  };
  inline_count_ = inline_count_ - (inline_main(before) ? 1 : 0) + (inline_main(count) ? 1 : 0);
  inline_count_variants_ =
      inline_count_variants_ - (inline_any(before) ? 1 : 0) + (inline_any(count) ? 1 : 0);
  if (count.main == 0 && count.variant == 0) {
    pub_names_.erase(name.hash);
  } else {
    pub_names_.set(name.hash, count);
  }
}

void Mirror::res_share_update(ResShare *old, ResShare now) {
  bool same_payloads = old->payloads.size() == now.payloads.size();
  for (std::size_t i = 0; same_payloads && i < now.payloads.size(); ++i) {
    same_payloads = old->payloads[i].first == now.payloads[i].first &&
                    old->payloads[i].second == now.payloads[i].second;
  }
  if (!same_payloads) {
    // Adds first, so a hash both lists hold never leaves the map. The newest bytes a hash is
    // published with are the ones the map holds (the same content, a fresh copy: the
    // spurious-texture-update sabotage's re-copy, say).
    for (const auto &entry : now.payloads) {
      ++payload_users_[entry.first];
      const PayloadMap::value_type *held = pub_payloads_.find_entry(entry.first);
      if (held == nullptr || held->second != entry.second) {
        pub_payloads_.set(entry.first, entry.second);
      }
    }
    for (const auto &entry : old->payloads) {
      const auto it = payload_users_.find(entry.first);
      if (it != payload_users_.end() && --it->second == 0) {
        payload_users_.erase(it);
        pub_payloads_.erase(entry.first);
      }
    }
    old->payloads = std::move(now.payloads);
  }
  bool same_names = old->names.size() == now.names.size();
  for (std::size_t i = 0; same_names && i < now.names.size(); ++i) {
    same_names = old->names[i].hash == now.names[i].hash &&
                 old->names[i].variant == now.names[i].variant &&
                 old->names[i].payload_bytes == now.names[i].payload_bytes;
  }
  if (!same_names) {
    for (const ResName &name : now.names) {
      res_names_add(name, 1);
    }
    for (const ResName &name : old->names) {
      res_names_add(name, -1);
    }
    old->names = std::move(now.names);
  }
}

void Mirror::res_publish_resources(
    const std::vector<std::uint32_t> &tex_visit_in,
    std::vector<std::pair<std::uint32_t, std::shared_ptr<TextureJob>>> *jobs) {
  const auto share_of = [](std::unordered_map<std::uint32_t, ResShare> *shares,
                           std::uint32_t id) -> ResShare * {
    return &(*shares)[id];
  };
  const auto drop_share = [this](std::unordered_map<std::uint32_t, ResShare> *shares,
                                 std::uint32_t id) {
    const auto it = shares->find(id);
    if (it != shares->end()) {
      res_share_update(&it->second, ResShare());
      shares->erase(it);
    }
  };
  const auto name_adder = [](ResShare *share) {
    return [share](const std::string &hash, std::uint64_t bytes, bool variant) {
      share->names.push_back(ResName{hash, bytes, variant});
    };
  };

  // Textures: the ones visited before publish_items, and those erased or marked since.
  bool more_all = false;
  std::vector<std::uint32_t> tex_visit = textures_.take(&more_all);
  tex_visit.insert(tex_visit.end(), tex_visit_in.begin(), tex_visit_in.end());
  std::sort(tex_visit.begin(), tex_visit.end());
  tex_visit.erase(std::unique(tex_visit.begin(), tex_visit.end()), tex_visit.end());
  ResMap<Texture>::Map &tex_map = textures_.unmarked();
  tex_jobbed_.clear();  // every jobbed texture is in tex_visit
  for (std::uint32_t id : tex_visit) {
    const auto it = tex_map.find(id);
    if (it == tex_map.end()) {
      if (pub_textures_.erase(id)) {
        ++stats_.hc_resources_republished;
      }
      drop_share(&tex_share_, id);
      pending_ids_.erase(id);
      tex_tombstones_.erase(id);
      continue;
    }
    ++stats_.hc_resources_visited;
    Texture &texture = it->second;
    settle(&texture);  // G8kw: a finished worker's hash and bytes, before they are published
    ResShare share;
    TextureEntry entry;
    if (pending_ids_.count(id) != 0) {
      // G8kf: not ready, and never published as ok: carry it as `delivery-pending` (the shape the
      // hook already knows, no hash, no payload) and do not hold the snapshot back for it.
      Texture shown = texture;
      shown.status = TextureStatus::Unsupported;
      shown.has_reason = true;
      shown.reason = TextureReason::DeliveryPending;
      entry = wire_entry(shown);
      if (texture.pending_version != texture.version) {
        ++pending_published_;  // textures, not snapshots
      }
      texture.pending_version = texture.version;
    } else {
      if (texture.kind == TextureKind::Image && texture.status == TextureStatus::Ok &&
          texture.job == nullptr) {
        texture.published_ok = true;
      }
      entry = wire_entry(texture);
      if (texture.kind == TextureKind::Image && texture.status == TextureStatus::Ok &&
          texture.bytes != nullptr) {
        share.payloads.emplace_back(texture.copy.hash, texture.bytes);
        // G8kp: every variant the entry lists travels in the same content-addressed map (store,
        // HTTP), never as an inline record (rs_captured.h variant_refs).
        for (const rs2::TextureVariant &variant : entry.variants) {
          if (variant.hash == texture.copy.block_hash && texture.copy.block_bytes != nullptr) {
            share.payloads.emplace_back(variant.hash, texture.copy.block_bytes);
          } else if (variant.hash == texture.uastc_hash && texture.uastc_bytes != nullptr) {
            share.payloads.emplace_back(variant.hash, texture.uastc_bytes);  // G8ku: a KTX2
          }
        }
      } else if (texture.job != nullptr && texture.kind == TextureKind::Image &&
                 texture.status == TextureStatus::Ok) {
        jobs->emplace_back(id, texture.job);
      }
    }
    texture_entry_names(entry, name_adder(&share));
    const TextureEntry *old = pub_textures_.find(id);
    if (old == nullptr || texture_entry_difference(*old, entry) != nullptr) {
      pub_textures_.set(std::move(entry));
      ++stats_.hc_resources_republished;
    }
    res_share_update(share_of(&tex_share_, id), std::move(share));
    if (texture.status == TextureStatus::Freed) {
      tex_tombstones_.insert(id);
    } else {
      tex_tombstones_.erase(id);
    }
    if (texture.job != nullptr || texture.pending_version != 0) {
      tex_jobbed_.insert(id);
    }
    if (textures_.skip_dirty_) {
      textures_.published_.insert(id);
    }
  }

  // Meshes (G5e): each `ok` mesh's surfaces join the payload map under their wire hash (HC3).
  bool all = false;
  ResMap<Mesh>::Map &mesh_map = meshes_.unmarked();
  for (std::uint32_t id : meshes_.take(&all)) {
    const auto it = mesh_map.find(id);
    if (it == mesh_map.end()) {
      if (pub_meshes_.erase(id)) {
        ++stats_.hc_resources_republished;
      }
      drop_share(&mesh_share_, id);
      keyed_meshes_.erase(id);
      continue;
    }
    ++stats_.hc_resources_visited;
    classify_mesh(&it->second);  // W11b: no-op unless V11Options.enabled
    ResShare share;
    MeshEntry entry = wire_mesh(&it->second, &share.payloads);
    bool keyed = false;
    for (const MeshSurface &surface : entry.surfaces) {
      keyed = keyed || surface.hash_is_key;
    }
    if (keyed) {
      keyed_meshes_.insert(id);
    } else {
      keyed_meshes_.erase(id);
    }
    mesh_entry_names(entry, name_adder(&share));
    const MeshEntry *old = pub_meshes_.find(id);
    if (old == nullptr || mesh_entry_difference(*old, entry) != nullptr) {
      pub_meshes_.set(std::move(entry));
      ++stats_.hc_resources_republished;
    }
    res_share_update(share_of(&mesh_share_, id), std::move(share));
  }

  // G55d: shaders; the payload of every `ok` shader whose code travels (`source: "payload"`:
  // never a withheld one, D4) -- exactly payload_refs' set.
  ResMap<Shader>::Map &shader_map = shaders_.unmarked();
  for (std::uint32_t id : shaders_.take(&all)) {
    const auto it = shader_map.find(id);
    if (it == shader_map.end()) {
      if (pub_shaders_.erase(id)) {
        ++stats_.hc_resources_republished;
      }
      drop_share(&shader_share_, id);
      time_shaders_.erase(id);
      below_v12_shaders_.erase(id);
      continue;
    }
    ++stats_.hc_resources_visited;
    const Shader &shader = it->second;
    ShaderEntry wire = wire_shader(shader);
    if (wire.status == ShaderStatus::Ok &&
        std::find(wire.uses.begin(), wire.uses.end(), ShaderUse::Time) != wire.uses.end()) {
      time_shaders_.insert(id);
    } else {
      time_shaders_.erase(id);
    }
    if (wire.below_v12 != nullptr) {
      below_v12_shaders_.insert(id);
    } else {
      below_v12_shaders_.erase(id);
    }
    ResShare share;
    if (wire.status == ShaderStatus::Ok && wire.has_source &&
        wire.source == ShaderSource::Payload && wire.has_hash && shader.bytes != nullptr) {
      share.payloads.emplace_back(wire.hash, shader.bytes);
    }
    shader_entry_names(wire, name_adder(&share));
    const ShaderEntry *old = pub_shaders_.find(id);
    if (old == nullptr || shader_entry_difference(*old, wire) != nullptr) {
      pub_shaders_.set(std::move(wire));
      ++stats_.hc_resources_republished;
    }
    res_share_update(share_of(&shader_share_, id), std::move(share));
  }

  ResMap<Material>::Map &material_map = materials_.unmarked();
  for (std::uint32_t id : materials_.take(&all)) {
    const auto it = material_map.find(id);
    if (it == material_map.end()) {
      if (pub_materials_.erase(id)) {
        ++stats_.hc_resources_republished;
      }
      below_v12_materials_.erase(id);
      continue;
    }
    ++stats_.hc_resources_visited;
    MaterialEntry entry = wire_material(it->second);
    if (entry.below_v12 != nullptr) {
      below_v12_materials_.insert(id);
    } else {
      below_v12_materials_.erase(id);
    }
    const MaterialEntry *old = pub_materials_.find(id);
    if (old == nullptr || material_entry_difference(*old, entry) != nullptr) {
      pub_materials_.set(std::move(entry));
      ++stats_.hc_resources_republished;
    }
  }
  stats_.hc_dirty_marks_dropped_textures = textures_.dropped_;
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

  // HC4b (host-cost-design.md D1 "The snapshot"): the resource tables are published state too.
  // A snapshot after reset() or after a setting the entries depend on rebuilds them; a change of
  // dynamic_hashes_read() rebuilds the mesh entries (their surface hashes or keys).
  if (!pub_valid_) {
    res_clear();
  }
  if (dynamic_hashes_read() != res_dynamic_readers_) {
    res_dynamic_readers_ = dynamic_hashes_read();
    meshes_.mut_all();
  }
  // A material's unsupported verdict reads the material, its shader and textures (and the
  // pending set, which moves only with a visited texture): every verdict is recomputed when a
  // texture or shader moved, only the moved materials' when only materials did (publish_items).
  hc_verdict_inputs_moved_ = textures_.all_dirty_ || !textures_.dirty_.empty() ||
                             !textures_.gone_.empty() || !tex_jobbed_.empty() ||
                             !tex_recheck_.empty() || shaders_.all_dirty_ ||
                             !shaders_.dirty_.empty() || !shaders_.gone_.empty() ||
                             materials_.all_dirty_;
  // The textures to visit: the marked and erased ones, and every texture a worker or a pending
  // recovery still holds (tex_jobbed_: settled and recovered here, as the full walk did for
  // every texture).
  bool tex_all = false;
  std::vector<std::uint32_t> tex_visit = textures_.take(&tex_all);
  if (!tex_jobbed_.empty() || !tex_recheck_.empty()) {
    tex_visit.insert(tex_visit.end(), tex_jobbed_.begin(), tex_jobbed_.end());
    std::sort(tex_visit.begin(), tex_visit.end());
    tex_visit.erase(std::unique(tex_visit.begin(), tex_visit.end()), tex_visit.end());
  }
  // G8kf: the textures this snapshot carries as `delivery-pending` (see below). Decided first,
  // because an item naming one needs its derived unsupported-texture entry like any unsupported
  // texture (render-stream-2.md "Item-level unsupported entries"). HC4b: only a texture with a
  // job can be pending, and those are all visited, so the set is kept and updated in place.
  std::set<std::uint32_t> &pending_ids = pending_ids_;
  ResMap<Texture>::Map &tex_map = textures_.unmarked();
  for (std::uint32_t id : tex_visit) {
    const auto it = tex_map.find(id);
    if (it == tex_map.end()) {
      pending_ids.erase(id);
      tex_tombstones_.erase(id);
      continue;
    }
    Texture &texture = it->second;
    settle(&texture);
    if (resolve_pending(&texture)) {
      ++epoch_;  // the version moved under a snapshot taken before service_pending ran
    }
    if (publish_pending_ && texture.job != nullptr && texture.kind == TextureKind::Image &&
        texture.status == TextureStatus::Ok && !texture.published_ok) {
      pending_ids.insert(id);
    } else {
      pending_ids.erase(id);
    }
    if (texture.status == TextureStatus::Freed) {
      tex_tombstones_.insert(id);
    } else {
      tex_tombstones_.erase(id);
    }
  }
  // The inputs other items' derived entries read (publish_items step 3): a texture's own
  // unsupported-or-pending bit and its diffuse link, and a mesh's unsupported status, compared for
  // what moved (and for the textures the previous snapshot erased).
  hc_inputs_moved_ = false;
  {
    const auto tex_key = [&](std::uint32_t id) -> std::uint64_t {
      const Texture *t = textures_.find(id);
      if (t == nullptr) {
        return 0;
      }
      std::uint64_t key =
          t->status == TextureStatus::Unsupported || pending_ids.count(id) != 0 ? 1 : 0;
      if (t->kind == TextureKind::Canvas && t->has_diffuse) {
        key |= (static_cast<std::uint64_t>(t->diffuse_id) + 1) << 1;
      }
      return key;
    };
    const auto check = [&](std::uint32_t id) {
      const std::uint64_t key = tex_key(id);
      const auto it = tex_key_.find(id);
      const std::uint64_t old = it != tex_key_.end() ? it->second : 0;
      if (key == old) {
        return;
      }
      hc_inputs_moved_ = true;
      if (key == 0) {
        tex_key_.erase(it);
      } else {
        tex_key_[id] = key;
      }
    };
    for (std::uint32_t id : tex_visit) {
      check(id);
    }
    for (std::uint32_t id : tex_recheck_) {
      check(id);
    }
    tex_recheck_.clear();
    const auto mesh_check = [&](std::uint32_t id) {
      const Mesh *m = meshes_.find(id);
      const bool bad = m != nullptr && m->status == MeshStatus::Unsupported;
      if (bad ? bad_meshes_.insert(id).second : bad_meshes_.erase(id) != 0) {
        hc_inputs_moved_ = true;
      }
      if (m != nullptr && m->status == MeshStatus::Freed) {
        mesh_tombstones_.insert(id);
      } else {
        mesh_tombstones_.erase(id);
      }
    };
    if (meshes_.all_dirty_) {
      for (const auto &entry : meshes_.all()) {
        mesh_check(entry.first);
      }
      for (auto it = bad_meshes_.begin(); it != bad_meshes_.end();) {
        if (meshes_.find(*it) == nullptr) {
          hc_inputs_moved_ = true;
          it = bad_meshes_.erase(it);
        } else {
          ++it;
        }
      }
    } else {
      for (std::uint32_t id : meshes_.dirty_) {
        mesh_check(id);
      }
      for (std::uint32_t id : meshes_.gone_) {
        mesh_check(id);
      }
    }
  }
  std::set<std::uint32_t> referenced;  // the tombstone rule's texture references (see below)

  // protocol/unknown-item-skip.md: under Skip, every known item whose parent chain reaches an
  // unknown RID is left out of the published state -- its item entry, its item-level unsupported
  // entries and its draw-index groups. No published container lists one (a withheld item's parent
  // is unknown or withheld itself), so canvases and the remaining items need no filtering. The
  // texture table is not filtered: a tombstone a withheld command names stays, as under Strict.
  // HC4a: the items hung from an unknown RID are tracked per marked item, so the withheld walk
  // (every item's parent chain) runs only while one exists.
  if (!pub_valid_ || items_.all_dirty_) {
    unknown_parent_ids_.clear();
    for (const auto &entry : items_.all()) {
      if (entry.second.unknown_parent != 0) {
        unknown_parent_ids_.insert(entry.first);
      }
    }
  } else {
    for (std::uint32_t id : items_.dirty_) {
      const Item *item = items_.find(id);
      if (item != nullptr && item->unknown_parent != 0) {
        unknown_parent_ids_.insert(id);
      } else {
        unknown_parent_ids_.erase(id);
      }
    }
    for (std::uint32_t id : items_.gone_) {
      unknown_parent_ids_.erase(id);
    }
  }
  const std::set<std::uint32_t> withheld =
      unknown_parent_ids_.empty() ? std::set<std::uint32_t>() : withheld_ids();
  if (skip_unknown()) {
    UnknownItems &unknown = out.unknown_items;
    unknown.present = true;
    unknown.unknown_rids = unknown_rids_.size();
    unknown.withheld_items = withheld.size();
    for (std::uint32_t id : withheld) {
      unknown.withheld_commands += items_.find(id)->state.commands.size();
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
  // commands and rid instance parameters, a canvas texture's diffuse (G2d, gathered in the first
  // textures walk above), material rid parameters and shader default textures (G55d);
  // `meshes_named` every mesh an add_mesh names (G5e).
  //
  // HC4a (host-cost-design.md D1 "The snapshot"): the items' half of that walk visits every
  // item's commands, so it runs only while some tombstone exists (a rare state); without one the
  // named sets are never read.
  std::set<std::uint32_t> meshes_named;
  // PM1 (rule 9): the multimeshes any add_multimesh names (the tombstone rule).
  std::set<std::uint32_t> multimeshes_named;
  // PM5 ("Publication"): the emitters any add_particles names (the tombstone rule).
  std::set<std::uint32_t> particles_named;
  const bool pt_on = pt_options_.enabled;
  // HC4b: the texture and mesh tombstones are kept as sets (updated above for what moved).
  bool tombstones = !tex_tombstones_.empty() || !mesh_tombstones_.empty();
  for (const auto &entry : multimeshes_) {
    tombstones = tombstones || entry.second.freed;
  }
  for (const auto &entry : particles_) {
    tombstones = tombstones || entry.second.freed;
  }
  if (tombstones) {
    for (const auto &entry : items_.all()) {
      for (const Command &command : entry.second.state.commands) {
        if (names_texture(command) && command.has_tex) {
          referenced.insert(command.tex);
        }
        if (command.kind == CommandKind::AddMesh) {
          meshes_named.insert(command.mesh);
        } else if (command.kind == CommandKind::AddMultimesh) {
          multimeshes_named.insert(command.multimesh);
        } else if (command.kind == CommandKind::AddParticles) {
          particles_named.insert(command.particles);
        }
      }
      for (const auto &param : entry.second.instance_params) {
        if (param.second.has_tex) {
          referenced.insert(param.second.tex);
        }
      }
    }
  }
  // HC4a: the published items and canvases, the item-level entries and the items' references,
  // updated for what changed since the last snapshot (publish_items). The shadow oracle builds
  // them again by the full walk, here, where the walk always ran.
  ItemsPublished refs;
  publish_items(withheld, &refs);
  FullWalk walk;
  ItemsPublished walked_refs;  // the incremental references as of the walk (closed over below)
  if (hc_shadow_) {
    const std::set<std::uint32_t> withheld_full = withheld_ids();
    full_walk_items(withheld_full, &walk);
    walk.withheld_differs = withheld_full != withheld;
    walked_refs = refs;
  }
  std::set<std::uint32_t> &multimeshes_published = refs.multimeshes;
  std::set<std::uint32_t> &particles_published = refs.particles;
  out.multimesh_commands = refs.multimesh_commands;
  out.particles_commands = refs.particles_commands;
  // `referenced` is read only to drop texture tombstones, so (HC4b) the rest of it is gathered
  // only while one exists: a canvas texture's diffuse (G2d), material rid parameters and shader
  // default textures (G55d).
  if (!tex_tombstones_.empty()) {
    for (const auto &entry : textures_.all()) {
      const Texture &texture = entry.second;
      if (texture.kind == TextureKind::Canvas && texture.has_diffuse) {
        referenced.insert(texture.diffuse_id);
      }
    }
    for (const auto &entry : materials_.all()) {
      for (std::uint32_t tex : wire_params(entry.second).textures) {
        referenced.insert(tex);
      }
    }
    for (const auto &entry : shaders_.all()) {
      for (const auto &ref : entry.second.default_textures) {
        referenced.insert(ref.second);
      }
    }
    for (auto it = tex_tombstones_.begin(); it != tex_tombstones_.end();) {
      if (referenced.count(*it) == 0) {
        textures_.erase(*it);
        tex_recheck_.push_back(*it);
        it = tex_tombstones_.erase(it);
      } else {
        ++it;
      }
    }
  }
  // PM1: a multimesh's mesh keeps its tombstone (rule 6), and a multimesh tombstone leaves at the
  // first snapshot nothing names it, after its last state note.
  for (auto it = multimeshes_.begin(); it != multimeshes_.end();) {
    Multimesh &mm = it->second;
    note_multimesh(mm, frame);
    mm.noted_version = mm.version;
    if (mm.freed && multimeshes_named.count(it->first) == 0) {
      it = multimeshes_.erase(it);
      continue;
    }
    if (!mm.freed && !mm.unknown_mesh && mm.mesh_id != 0) {
      meshes_named.insert(mm.mesh_id);
    }
    ++it;
  }
  // PM5: an emitter's draw pass meshes keep their tombstones; an emitter tombstone leaves at the
  // first snapshot nothing names it (no add_particles, no live emitter's subemitter), after its
  // last state note.
  if (pt_on) {
    for (const auto &entry : particles_) {
      if (!entry.second.freed && !entry.second.unknown_sub && entry.second.sub_id != 0) {
        particles_named.insert(entry.second.sub_id);
      }
    }
    for (auto it = particles_.begin(); it != particles_.end();) {
      Particles &pt = it->second;
      note_particles(pt, frame);
      pt.noted_version = pt.version;
      if (pt.freed && particles_named.count(it->first) == 0) {
        it = particles_.erase(it);
        continue;
      }
      for (std::size_t k = 0; !pt.freed && k < pt.pass_ids.size(); ++k) {
        if (!pt.pass_unknown[k] && pt.pass_ids[k] != 0) {
          meshes_named.insert(pt.pass_ids[k]);
        }
      }
      ++it;
    }
  }
  // G5e: likewise a mesh tombstone leaves at the first snapshot no add_mesh names it.
  for (auto it = mesh_tombstones_.begin(); it != mesh_tombstones_.end();) {
    if (meshes_named.count(*it) == 0) {
      meshes_.erase(*it);
      it = mesh_tombstones_.erase(it);
    } else {
      ++it;
    }
  }
  out.unsupported.insert(out.unsupported.end(), item_level_.begin(), item_level_.end());
  out.canvases = pub_canvases_;
  out.items = pub_items_;
  // HC4b: the resource tables, the payload map and the name index, updated for the entries that
  // moved (res_publish_resources); this snapshot shares the rest.
  std::vector<std::pair<std::uint32_t, std::shared_ptr<TextureJob>>> jobs;
  res_publish_resources(tex_visit, &jobs);
  out.textures = pub_textures_;
  out.meshes = pub_meshes_;
  out.shaders = pub_shaders_;
  out.materials = pub_materials_;
  for (auto &job : jobs) {
    // G8kw: still on a worker. The entry is complete but for its hash; the caller holds the
    // snapshot back until resolve_captured() can fill it (rs_texture_worker.h).
    PendingTexture pending;
    pending.index = out.textures.index_of(job.first);
    pending.job = std::move(job.second);
    captured.pending.push_back(std::move(pending));
  }
  captured.payloads = pub_payloads_;
  captured.keyed_surfaces = !keyed_meshes_.empty();
  captured.names = pub_names_;
  captured.names_valid = true;
  captured.names_inline_max = inline_max_;
  captured.inline_count = inline_count_;
  captured.inline_count_variants = inline_count_variants_;
  if (!below_v12_shaders_.empty() || !below_v12_materials_.empty()) {
    out.particles_commands = true;  // PM5: a /11 connection sees the /11 form
  }
  if (carry_shader_time_ && !time_shaders_.empty()) {
    out.shader_time = shader_time_;  // P3-TM
  }
  if (pt_on) {
    // PM5 ("Publication"): the emitters a published add_particles names, closed over the
    // subemitters of published entries; tombstones included.
    std::vector<std::uint32_t> work(particles_published.begin(), particles_published.end());
    while (!work.empty()) {
      const std::uint32_t id = work.back();
      work.pop_back();
      const auto it = particles_.find(id);
      if (it == particles_.end() || it->second.freed || it->second.unknown_sub) {
        continue;
      }
      const std::uint32_t sub = it->second.sub_id;
      if (sub != 0 && particles_published.insert(sub).second) {
        work.push_back(sub);
      }
    }
    // Sabotage freeze-send-positions (FRZ-P): from the frame on, the frozen seat's encoder emits
    // every ok emitter's current emission transform (its position) each frame, the per-frame
    // positions the freeze forbids. The emit is counted (version and `emits` move) so the wire
    // stays valid; it changes every transaction's bytes, so the wire-byte-identity check catches it.
    if (pt_options_.send_positions_frame != 0 && frame >= pt_options_.send_positions_frame) {
      for (std::uint32_t id : particles_published) {
        auto it = particles_.find(id);
        if (it == particles_.end() || it->second.freed || !it->second.mode_2d) {
          continue;
        }
        rs2::ParticleEmit e;
        e.particles = id;
        e.restarts = it->second.restarts - it->second.restarts_dropped;
        e.flags = 0;
        const std::shared_ptr<std::vector<float>> &fl = it->second.floats;
        if (fl != nullptr && fl->size() >= kParticlesBaseFloats) {
          // The emission transform (floats 16..27) is the emitter's position this frame.
          for (std::size_t k = 0; k < 12; ++k) {
            e.floats[k] = (*fl)[16 + k];
          }
        }
        e.floats[15] = 1.0f;  // colour alpha (an opaque particle), velocity/custom stay zero
        pending_emits_.push_back(std::move(e));
        ++it->second.emits;
        ++it->second.version;
      }
    }
    out.particles.reserve(particles_published.size());
    for (std::uint32_t id : particles_published) {
      const auto it = particles_.find(id);
      if (it != particles_.end()) {
        out.particles.push_back(wire_particles(it->second, false));
      }
    }
    // The emit log: this frame's emits become one chunk; the tail keeps the last 4,096 emits.
    if (!pending_emits_.empty()) {
      auto chunk = std::make_shared<rs2::EmitChunk>();
      chunk->frame = frame;
      chunk->emits.swap(pending_emits_);
      auto tail = std::make_shared<rs2::EmitTail>();
      if (emit_tail_ != nullptr) {
        *tail = *emit_tail_;
      }
      tail->push_back(chunk);
      std::size_t total = 0;
      for (const auto &c : *tail) {
        total += c->emits.size();
      }
      while (total > rs2::kParticleEmitTail && !tail->empty()) {
        const std::size_t first = tail->front()->emits.size();
        if (total - first >= rs2::kParticleEmitTail) {
          total -= first;
          tail->erase(tail->begin());
          continue;
        }
        // Trim the oldest chunk to exactly the tail's bound.
        auto trimmed = std::make_shared<rs2::EmitChunk>(*tail->front());
        const std::size_t drop = total - rs2::kParticleEmitTail;
        trimmed->emits.erase(trimmed->emits.begin(),
                             trimmed->emits.begin() + static_cast<long>(drop));
        tail->front() = trimmed;
        total -= drop;
      }
      emit_tail_ = tail;
    }
    out.emit_tail = emit_tail_;
  }
  // PM1 (rule 9): the multimeshes a published add_multimesh names, tombstones included.
  out.multimeshes.reserve(multimeshes_published.size());
  for (std::uint32_t id : multimeshes_published) {
    const auto it = multimeshes_.find(id);
    if (it != multimeshes_.end()) {
      out.multimeshes.push_back(wire_multimesh(it->second));
    }
  }
  if (hc_shadow_) {
    full_walk_resources(&walk);
    shadow_compare(walk, walked_refs, &captured);
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
  out.live_multimeshes = multimeshes_.size();
  out.live_particles = particles_.size();
  std::set<std::string> mesh_hashes;
  std::set<const PayloadBytes *> mesh_unhashed;  // HC3: a surface not hashed (yet) counts by buffer
  for (const auto &entry : meshes_) {
    if (entry.second.dynamic) {
      ++out.meshes_dynamic;  // W11b
    }
    for (const MeshSurf &surface : entry.second.surfaces) {
      if (surface.bytes == nullptr) {
        continue;
      }
      if (surface.hash.empty() ? mesh_unhashed.insert(surface.bytes.get()).second
                               : mesh_hashes.insert(surface.hash).second) {
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

void mirror_set_dynamic_hash_readers(bool readers) {
  mirror_instance().set_dynamic_hash_readers(readers);
}

void mirror_set_perturb_shader(std::uint64_t from_frame) {
  mirror_instance().set_perturb_shader(from_frame);
}

void mirror_set_shader_policy(ShaderPolicy policy) { mirror_instance().set_shader_policy(policy); }
void mirror_set_particles(const Mirror::ParticlesOptions &options) {
  mirror_instance().set_particles(options);
}
void mirror_set_multimesh(const Mirror::MultimeshOptions &options) {
  mirror_instance().set_multimesh(options);
}

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
