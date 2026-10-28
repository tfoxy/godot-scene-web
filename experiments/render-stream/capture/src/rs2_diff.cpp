#include "rs2_diff.h"

#include <algorithm>
#include <cstring>
#include <map>
#include <set>
#include <utility>

namespace grc {
namespace rs2 {

namespace {

bool floats_equal_bits(float a, float b) {
  std::uint32_t ba = 0;
  std::uint32_t bb = 0;
  std::memcpy(&ba, &a, sizeof(ba));
  std::memcpy(&bb, &b, sizeof(bb));
  return ba == bb;
}

template <typename Arr>
bool arrays_equal_bits(const Arr &a, const Arr &b) {
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (!floats_equal_bits(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

// new at /5: param_f64 carries float64 (double), not float32, so Param values need their own
// bit-exact comparison (gate5_5-design.md D8: "Float64 keeps FLOAT (a double) and INT exact").
bool doubles_equal_bits(double a, double b) {
  std::uint64_t ba = 0;
  std::uint64_t bb = 0;
  std::memcpy(&ba, &a, sizeof(ba));
  std::memcpy(&bb, &b, sizeof(bb));
  return ba == bb;
}

bool double_vectors_equal_bits(const std::vector<double> &a, const std::vector<double> &b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (!doubles_equal_bits(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

// render-stream-5.md "Material table"/"Item": every JSON field of a <param> participates, plus
// its floats (bit-exact).
bool param_equal(const Param &a, const Param &b) {
  if (a.name != b.name || a.type != b.type || a.n != b.n || a.has_tex != b.has_tex) {
    return false;
  }
  if (a.has_tex && a.tex != b.tex) {
    return false;
  }
  return double_vectors_equal_bits(a.floats, b.floats);
}

bool params_equal(const std::vector<Param> &a, const std::vector<Param> &b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (!param_equal(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

bool params_equal(const SharedVector<Param> &a, const SharedVector<Param> &b) {
  // P3-CAP: an entry the mirror republished unchanged shares its parameters with the base.
  return a.shares(b) || params_equal(a.vector(), b.vector());
}

// render-stream-1.md "Patch transactions", unchanged at /2: "An entry differs when any JSON
// value or any of its block floats differs; floats compare by their 32-bit pattern. `commands`
// do not take part in the comparison; `content_version` stands for them." texture_filter/
// texture_repeat are new JSON fields that participate like any other.
// gate5_5-design.md D9: "material, use_parent_material and instance_params are item state, never
// content_version" -- they participate here unconditionally, exactly like texture_filter/
// texture_repeat, never exempted by a content_version match the way `commands` is.
//
// render-stream-10.md "Item": canvas_group and copy_to_backbuffer are item state too, but they
// exist on the wire at /10 only, so they take part only when `v10`: below /10 a patch stays exactly
// what it was (the keys are not encoded, so an entry for them alone would be an unchanged entry).
bool canvas_group_equal(const CanvasGroupState &a, const CanvasGroupState &b) {
  if (a.mode != b.mode) {
    return false;
  }
  if (a.mode == CanvasGroupMode::Disabled) {
    return true;  // null: the engine keeps none of a disabled call's arguments
  }
  return a.fit_empty == b.fit_empty && a.blur_mipmaps == b.blur_mipmaps &&
         arrays_equal_bits(std::array<float, 2>{a.clear_margin, a.fit_margin},
                           std::array<float, 2>{b.clear_margin, b.fit_margin});
}

bool backbuffer_state_equal(const ItemState &a, const ItemState &b) {
  if (!canvas_group_equal(a.canvas_group, b.canvas_group) ||
      a.copy_to_backbuffer != b.copy_to_backbuffer) {
    return false;
  }
  return !a.copy_to_backbuffer ||
         arrays_equal_bits(a.copy_to_backbuffer_rect, b.copy_to_backbuffer_rect);
}

bool item_state_equal(const ItemState &a, const ItemState &b, bool v10, bool v11) {
  if (v10 && !backbuffer_state_equal(a, b)) {
    return false;
  }
  // UIT (render-stream-11.md "As built (UIT)"): use_identity_transform is on the wire at /11 only.
  if (v11 && a.use_identity_transform != b.use_identity_transform) {
    return false;
  }
  if (a.parent.kind != b.parent.kind) {
    return false;
  }
  if (a.parent.kind != ParentKind::None && a.parent.id != b.parent.id) {
    return false;
  }
  if (a.children != b.children || a.visible != b.visible || a.draw_index != b.draw_index ||
      a.z_index != b.z_index || a.z_relative != b.z_relative || a.behind != b.behind ||
      a.clip != b.clip || a.custom_rect != b.custom_rect ||
      a.visibility_layer != b.visibility_layer || a.texture_filter != b.texture_filter ||
      a.texture_repeat != b.texture_repeat || a.content_version != b.content_version ||
      a.has_material != b.has_material || a.use_parent_material != b.use_parent_material) {
    return false;
  }
  if (a.has_material && a.material != b.material) {
    return false;
  }
  if (!params_equal(a.instance_params, b.instance_params)) {
    return false;
  }
  return arrays_equal_bits(a.xform, b.xform) && arrays_equal_bits(a.modulate, b.modulate) &&
         arrays_equal_bits(a.self_modulate, b.self_modulate) &&
         arrays_equal_bits(a.custom_rect_rect, b.custom_rect_rect);
}

bool canvas_state_equal(const CanvasState &a, const CanvasState &b) {
  if (a.origin != b.origin || a.role != b.role || a.attached != b.attached || a.items != b.items) {
    return false;
  }
  // new at /6: layer/sublayer participate too (render-stream-6.md "Canvas"); every pre-/6
  // CanvasState leaves them at the default (0, 0), so this is a no-op for /2-/5 comparisons.
  if (a.layer != b.layer || a.sublayer != b.sublayer) {
    return false;
  }
  // new at /5: canvas modulate participates too (render-stream-5.md "Canvas"); every pre-/5
  // CanvasState leaves it at the default kWhite, so this is a no-op for /2-/4 comparisons.
  return arrays_equal_bits(a.xform, b.xform) && arrays_equal_bits(a.modulate, b.modulate);
}

bool canvas_texture_info_equal(const CanvasTextureInfo &a, const CanvasTextureInfo &b) {
  if (a.has_diffuse != b.has_diffuse) {
    return false;
  }
  if (a.has_diffuse && a.diffuse != b.diffuse) {
    return false;
  }
  return a.filter == b.filter && a.repeat == b.repeat;
}

// render-stream-2.md "Full and patch transactions": "Its `textures` lists exactly the entries
// that are new or differ in any JSON value." Textures carry no floats and no content_version
// exemption, so every field participates.
//
// HC3: a surface whose `hash` is a payload key (MeshSurface::hash_is_key) is a dynamic /11 one,
// whose bytes the content serial already compares (mesh_entry_equal): its key is not compared with
// a real hash, so a snapshot taken while a viewer below /11 read the hashes and one taken after
// compare exactly as two hashed ones would (equal serials mean equal bytes).
bool mesh_surface_equal(const MeshSurface &a, const MeshSurface &b) {
  return (a.hash_is_key != b.hash_is_key || a.hash == b.hash) &&
         a.payload_bytes == b.payload_bytes && a.primitive == b.primitive &&
         a.format == b.format && a.vertex_count == b.vertex_count && a.index_count == b.index_count;
}

// render-stream-11.md "Mesh entry": a mesh whose surfaces travel as bodies (`ok`, flagged, with at
// least one surface).
bool is_dynamic_mesh(const MeshEntry &m) {
  return m.dynamic && m.status == MeshStatus::Ok && !m.surfaces.empty();
}

bool same_mesh_shape(const MeshEntry &a, const MeshEntry &b) {
  if (a.surfaces.size() != b.surfaces.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.surfaces.size(); ++i) {
    const MeshSurface &x = a.surfaces[i];
    const MeshSurface &y = b.surfaces[i];
    if (x.primitive != y.primitive || x.format != y.format || x.vertex_count != y.vertex_count ||
        x.index_count != y.index_count) {
      return false;
    }
  }
  return true;
}

// render-stream-11.md "Mesh entry" and "Capture policy" (the serial rule): a /11 patch entry for a
// dynamic mesh sends its bodies (u8 non-null) unless the base's entry was already dynamic, with the
// same surface count and shape fields, and the same content serial. A function of (B, T) alone.
bool mesh_bodies_needed(const MeshEntry *base, const MeshEntry &cur) {
  if (!is_dynamic_mesh(cur)) {
    return false;  // static, unsupported or freed: u8 is null and nothing is held
  }
  if (base == nullptr || !is_dynamic_mesh(*base) || !same_mesh_shape(*base, cur)) {
    return true;  // new entry, the transition from static, or a shape change
  }
  return base->content_serial != cur.content_serial;
}

bool unsupported_equal(const std::vector<UnsupportedRef> &a, const std::vector<UnsupportedRef> &b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (a[i].op != b[i].op || a[i].has_item != b[i].has_item ||
        (a[i].has_item && a[i].item != b[i].item) || a[i].reason != b[i].reason) {
      return false;
    }
  }
  return true;
}

// render-stream-4.md "Mesh table": "exactly the texture table's full/patch/resolve semantics",
// so every JSON field participates (no content_version-style exemption, same as textures).
//
// render-stream-11.md "Dynamic mesh surfaces": at /11 a dynamic mesh's class and content serial
// are part of the entry too (a changed body puts the entry in the patch); below /11 neither exists
// on the wire, so they never take part.
bool mesh_entry_equal(const MeshEntry &a, const MeshEntry &b, bool v11) {
  if (a.origin != b.origin || a.adopted_content != b.adopted_content) {
    return false;
  }
  if (v11 && (is_dynamic_mesh(a) != is_dynamic_mesh(b) ||
              (is_dynamic_mesh(a) && a.content_serial != b.content_serial))) {
    return false;
  }
  if (a.status != b.status || a.has_reason != b.has_reason) {
    return false;
  }
  if (a.has_reason && a.reason != b.reason) {
    return false;
  }
  if (a.version != b.version || a.has_aabb != b.has_aabb) {
    return false;
  }
  if (a.has_aabb && !arrays_equal_bits(a.custom_aabb, b.custom_aabb)) {
    return false;
  }
  if (a.surfaces.size() != b.surfaces.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.surfaces.size(); ++i) {
    if (!mesh_surface_equal(a.surfaces[i], b.surfaces[i])) {
      return false;
    }
  }
  return true;
}

// PM1 (render-stream-11.md "As built (PM1)" rule 9): a patch lists a multimesh entry that differs
// in any JSON value other than the two offsets -- its custom AABB floats included (by bit
// pattern), its buffer not (rule 3 decides that from the serials).
bool multimesh_entry_equal(const MultimeshEntry &a, const MultimeshEntry &b) {
  if (a.origin != b.origin || a.status != b.status || a.has_reason != b.has_reason ||
      (a.has_reason && a.reason != b.reason) || a.version != b.version ||
      a.has_mesh != b.has_mesh || (a.has_mesh && a.mesh != b.mesh) || a.format != b.format ||
      a.colors != b.colors || a.custom != b.custom || a.instances != b.instances ||
      a.visible != b.visible) {
    return false;
  }
  return a.status == MultimeshStatus::Freed || arrays_equal_bits(a.custom_aabb, b.custom_aabb);
}

// Rule 3: an `ok` entry writes its buffer in a full transaction (base null here too), for an
// entry new to the table, when the base entry was not `ok`, after a change of instances, format,
// colors or custom, and otherwise exactly when its buffer serial moved between base and target.
bool multimesh_buffer_needed(const MultimeshEntry *base, const MultimeshEntry &cur) {
  if (cur.status != MultimeshStatus::Ok) {
    return false;
  }
  if (base == nullptr || base->status != MultimeshStatus::Ok || base->instances != cur.instances ||
      base->format != cur.format || base->colors != cur.colors || base->custom != cur.custom) {
    return true;
  }
  return base->buffer_serial != cur.buffer_serial;
}

const char kAddMultimeshOp[] = "canvas_item_add_multimesh";

bool lowers(const Command &command) {
  return command.kind == CommandKind::AddMultimesh ||
         (command.kind == CommandKind::Unsupported && command.name == kAddMultimeshOp);
}

// PM5 (render-stream-12.md "Particles table"): a patch lists an entry whose JSON fields or floats
// (by bit pattern) differ from the base's.
bool particles_entry_equal(const ParticlesEntry &a, const ParticlesEntry &b) {
  if (a.status != b.status || a.has_reason != b.has_reason ||
      (a.has_reason && a.reason != b.reason) || a.version != b.version ||
      a.mode_2d != b.mode_2d || a.emitting != b.emitting || a.amount != b.amount ||
      a.one_shot != b.one_shot || a.fixed_fps != b.fixed_fps || a.interpolate != b.interpolate ||
      a.fractional_delta != b.fractional_delta || a.local != b.local ||
      a.draw_order != b.draw_order || a.transform_align != b.transform_align ||
      a.trails != b.trails || a.trail_poses != b.trail_poses || a.seed != b.seed ||
      a.restarts != b.restarts || a.emits != b.emits ||
      a.process_requests != b.process_requests || a.process_material != b.process_material ||
      a.draw_passes != b.draw_passes || a.subemitter != b.subemitter) {
    return false;
  }
  if ((a.floats == nullptr) != (b.floats == nullptr)) {
    return false;
  }
  if (a.floats == nullptr || a.floats == b.floats) {
    return true;
  }
  return a.floats->size() == b.floats->size() &&
         (a.floats->empty() ||
          std::memcmp(a.floats->data(), b.floats->data(), a.floats->size() * sizeof(float)) == 0);
}

const char kAddParticlesOp[] = "canvas_item_add_particles";

bool lowers_particles(const Command &command) {
  return command.kind == CommandKind::AddParticles ||
         (command.kind == CommandKind::Unsupported && command.name == kAddParticlesOp);
}

// The emits of the chunks in (after, upto] of `tail`, in call order.
void append_emits(const std::shared_ptr<const EmitTail> &tail, std::uint64_t after,
                  std::uint64_t upto, std::vector<ParticleEmit> *out) {
  if (tail == nullptr) {
    return;
  }
  for (const std::shared_ptr<const EmitChunk> &chunk : *tail) {
    if (chunk != nullptr && chunk->frame > after && chunk->frame <= upto) {
      out->insert(out->end(), chunk->emits.begin(), chunk->emits.end());
    }
  }
}

// render-stream-5.md "Shader table"/"Material table": exactly the texture/mesh table's full,
// patch and resolve semantics (gate5_5-design.md D1), so every JSON field participates.
bool default_texture_ref_equal(const DefaultTextureRef &a, const DefaultTextureRef &b) {
  return a.name == b.name && a.index == b.index && a.tex == b.tex;
}

bool builtin_cim_equal(const BuiltinCanvasItemMaterial &a, const BuiltinCanvasItemMaterial &b) {
  return a.blend_mode == b.blend_mode && a.light_mode == b.light_mode &&
         a.particles_animation == b.particles_animation;
}

bool shader_entry_equal(const ShaderEntry &a, const ShaderEntry &b) {
  if (a.origin != b.origin) {
    return false;
  }
  if (a.status != b.status || a.has_reason != b.has_reason) {
    return false;
  }
  if (a.has_reason && a.reason != b.reason) {
    return false;
  }
  if (a.version != b.version || a.has_mode != b.has_mode) {
    return false;
  }
  if (a.has_mode && a.mode != b.mode) {
    return false;
  }
  if (a.has_source != b.has_source) {
    return false;
  }
  if (a.has_source && a.source != b.source) {
    return false;
  }
  if (a.has_hash != b.has_hash) {
    return false;
  }
  if (a.has_hash && a.hash != b.hash) {
    return false;
  }
  if (a.payload_bytes != b.payload_bytes || a.has_builtin != b.has_builtin) {
    return false;
  }
  if (a.has_builtin && !builtin_cim_equal(a.builtin, b.builtin)) {
    return false;
  }
  if (a.has_ppm != b.has_ppm || (a.has_ppm && a.ppm != b.ppm)) {
    return false;  // PM5: the particle_process_material builtin
  }
  if (a.uses != b.uses) {
    return false;
  }
  if (a.default_textures.size() != b.default_textures.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.default_textures.size(); ++i) {
    if (!default_texture_ref_equal(a.default_textures[i], b.default_textures[i])) {
      return false;
    }
  }
  return true;
}

bool material_entry_equal(const MaterialEntry &a, const MaterialEntry &b) {
  if (a.origin != b.origin) {
    return false;
  }
  if (a.status != b.status || a.has_reason != b.has_reason) {
    return false;
  }
  if (a.has_reason && a.reason != b.reason) {
    return false;
  }
  if (a.version != b.version || a.has_shader != b.has_shader) {
    return false;
  }
  if (a.has_shader && a.shader != b.shader) {
    return false;
  }
  return params_equal(a.params, b.params);
}

bool texture_entry_equal(const TextureEntry &a, const TextureEntry &b) {
  // new at /8: origin, adopted_content and source_format participate in the entry's identity
  // (they are defaults below /8, so every earlier comparison is unchanged).
  if (a.origin != b.origin || a.adopted_content != b.adopted_content ||
      a.has_source_format != b.has_source_format ||
      (a.has_source_format && a.source_format != b.source_format)) {
    return false;
  }
  if (a.kind != b.kind || a.status != b.status || a.has_reason != b.has_reason) {
    return false;
  }
  if (a.has_reason && a.reason != b.reason) {
    return false;
  }
  if (a.version != b.version || a.has_hash != b.has_hash) {
    return false;
  }
  if (a.has_hash && a.hash != b.hash) {
    return false;
  }
  if (a.has_format != b.has_format) {
    return false;
  }
  if (a.has_format && a.format != b.format) {
    return false;
  }
  if (a.width != b.width || a.height != b.height || a.mipmaps != b.mipmaps ||
      a.payload_bytes != b.payload_bytes || a.has_canvas != b.has_canvas) {
    return false;
  }
  if (a.has_canvas && !canvas_texture_info_equal(a.canvas, b.canvas)) {
    return false;
  }
  // new at /9: variants (empty below /9) take part in the entry's identity, so a variant that
  // appears at an equal version is a patch entry (texture-delivery-design.md D6).
  if (a.variants.size() != b.variants.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.variants.size(); ++i) {
    const TextureVariant &x = a.variants[i];
    const TextureVariant &y = b.variants[i];
    if (x.encoding != y.encoding || x.hash != y.hash || x.payload_bytes != y.payload_bytes ||
        x.has_format != y.has_format || x.format != y.format || x.has_params != y.has_params ||
        x.params != y.params) {
      return false;
    }
  }
  return true;
}

ItemEntry full_entry(const ItemState &item) {
  ItemEntry entry;
  entry.state = item;
  entry.commands_null = false;
  return entry;
}

}  // namespace

Transaction make_full(const Snapshot &cur) {
  TxMeta meta;
  meta.version = cur.version;
  meta.seq = cur.seq;
  meta.frame = cur.frame;
  return make_full(cur, meta);
}

Transaction make_full(const Snapshot &cur, const TxMeta &meta) {
  if (!is_v12_or_later(meta.version) && cur.particles_commands) {
    return make_full(lower_particles(cur), meta);  // PM5: /11's lowering
  }
  if (!is_v11_or_later(meta.version) && cur.multimesh_commands) {
    return make_full(lower_multimesh(cur), meta);  // PM1 rule 7
  }
  Transaction t;
  t.version = meta.version;
  t.seq = meta.seq;
  t.frame = meta.frame;
  t.encoding = Encoding::Full;
  t.base_seq.reset();
  t.failures = cur.failures;
  t.unsupported = cur.unsupported;
  t.unknown_items = cur.unknown_items;
  t.shader_time = cur.shader_time;  // P3-TM: complete, never patched
  t.default_texture_filter = cur.default_texture_filter;
  t.default_texture_repeat = cur.default_texture_repeat;
  t.canvases = cur.canvases;
  t.textures = cur.textures;
  if (t.version == ProtocolVersion::V4 || t.version == ProtocolVersion::V5 ||
      t.version == ProtocolVersion::V6 || t.version == ProtocolVersion::V7 ||
      t.version == ProtocolVersion::V8 || t.version == ProtocolVersion::V9 ||
      is_v10_or_later(t.version)) {
    t.meshes = cur.meshes;  // /11: a full sends every dynamic body (mesh_bodies_held empty)
  }
  if (t.version == ProtocolVersion::V5 || t.version == ProtocolVersion::V6 ||
      t.version == ProtocolVersion::V7 || t.version == ProtocolVersion::V8 ||
      t.version == ProtocolVersion::V9 || is_v10_or_later(t.version)) {
    t.shaders = cur.shaders;
    t.materials = cur.materials;
  }
  if (is_v11_or_later(t.version)) {
    // PM1 rules 1 and 3: every entry, every `ok` buffer (multimesh_buffers_held stays empty).
    t.multimeshes = cur.multimeshes;
    t.perturb_instance = meta.perturb_instance;
  }
  if (is_v12_or_later(t.version)) {
    // PM5: every entry; the emits of T's own frame only (a joiner does not replay history).
    t.particles = cur.particles;
    append_emits(cur.emit_tail, cur.frame - 1, cur.frame, &t.particle_emits);
    t.perturb_seed = meta.perturb_seed;
  }
  t.items.reserve(cur.items.size());
  for (const ItemState &item : cur.items) {
    t.items.push_back(full_entry(item));
  }
  return t;
}

namespace {

// P3-CAP: a table's entries by id -- what std::map<id, const T *> gave make_patch (the last entry
// of a repeated id wins, iteration ascending by id), in one sorted vector.
template <typename T>
class IdIndex {
 public:
  explicit IdIndex(const std::vector<T> &table) {
    entries_.reserve(table.size());
    for (const T &entry : table) {
      entries_.emplace_back(entry.id, &entry);
    }
    // Stable, so of a repeated id the last one stays last; keep only that one.
    std::stable_sort(entries_.begin(), entries_.end(),
                     [](const Entry &a, const Entry &b) { return a.first < b.first; });
    std::size_t out = 0;
    for (std::size_t i = 0; i < entries_.size(); ++i) {
      if (i + 1 < entries_.size() && entries_[i + 1].first == entries_[i].first) {
        continue;
      }
      entries_[out++] = entries_[i];
    }
    entries_.resize(out);
  }

  const T *find(std::uint32_t id) const {
    const auto it = std::lower_bound(entries_.begin(), entries_.end(), id,
                                     [](const Entry &e, std::uint32_t key) { return e.first < key; });
    return it != entries_.end() && it->first == id ? it->second : nullptr;
  }

  // Appends, ascending, every id of this index that `other` does not hold.
  template <typename U>
  void removed_from(const IdIndex<U> &other, std::vector<std::uint32_t> *out) const {
    for (const Entry &entry : entries_) {
      if (other.find(entry.first) == nullptr) {
        out->push_back(entry.first);
      }
    }
  }

 private:
  using Entry = std::pair<std::uint32_t, const T *>;
  std::vector<Entry> entries_;
};

}  // namespace

Transaction make_patch(const Snapshot &base, const Snapshot &cur) {
  TxMeta meta;
  meta.version = cur.version;
  meta.seq = cur.seq;
  meta.frame = cur.frame;
  meta.base_seq = base.seq;
  return make_patch(base, cur, meta);
}

Transaction make_patch(const Snapshot &base, const Snapshot &cur, const TxMeta &meta) {
  if (!is_v12_or_later(meta.version) && (cur.particles_commands || base.particles_commands)) {
    return make_patch(lower_particles(base), lower_particles(cur), meta);  // PM5: /11's lowering
  }
  if (!is_v11_or_later(meta.version) && (cur.multimesh_commands || base.multimesh_commands)) {
    return make_patch(lower_multimesh(base), lower_multimesh(cur), meta);  // PM1 rule 7
  }
  Transaction t;
  t.version = meta.version;
  t.seq = meta.seq;
  t.frame = meta.frame;
  t.encoding = Encoding::Patch;
  t.base_seq = meta.base_seq;
  t.failures = cur.failures;
  t.unsupported = cur.unsupported;
  t.unknown_items = cur.unknown_items;
  t.shader_time = cur.shader_time;  // P3-TM: complete, never patched
  t.default_texture_filter = cur.default_texture_filter;
  t.default_texture_repeat = cur.default_texture_repeat;

  // P3-CAP: sorted id indexes (one allocation per table) instead of node-based maps and sets.
  const IdIndex<CanvasState> base_canvases(base.canvases);
  const IdIndex<ItemState> base_items(base.items);
  const IdIndex<TextureEntry> base_textures(base.textures);
  const IdIndex<MeshEntry> base_meshes(base.meshes);
  const IdIndex<ShaderEntry> base_shaders(base.shaders);
  const IdIndex<MaterialEntry> base_materials(base.materials);
  const IdIndex<CanvasState> cur_canvas_ids(cur.canvases);
  const IdIndex<ItemState> cur_item_ids(cur.items);
  const IdIndex<TextureEntry> cur_texture_ids(cur.textures);
  const IdIndex<MeshEntry> cur_mesh_ids(cur.meshes);
  const IdIndex<ShaderEntry> cur_shader_ids(cur.shaders);
  const IdIndex<MaterialEntry> cur_material_ids(cur.materials);

  base_canvases.removed_from(cur_canvas_ids, &t.removed_canvases);
  base_items.removed_from(cur_item_ids, &t.removed_items);
  base_textures.removed_from(cur_texture_ids, &t.removed_textures);
  const bool v10 = is_v10_or_later(t.version);  // "V10 or later"
  const bool v11 = is_v11_or_later(t.version);
  // render-stream-11.md "Patched `unsupported`": null when the list equals the base's.
  t.unsupported_as_base = v11 && unsupported_equal(base.unsupported, cur.unsupported);
  // is_v5 means "V5 or later" (render-stream-6.md/-7.md are a delta on /5's tables, carrying
  // its shader/material tables and mesh table forward unchanged).
  const bool is_v5 = t.version == ProtocolVersion::V5 || t.version == ProtocolVersion::V6 ||
                      t.version == ProtocolVersion::V7 || t.version == ProtocolVersion::V8 ||
                      t.version == ProtocolVersion::V9 || v10;
  const bool is_v4_or_later = is_v5 || t.version == ProtocolVersion::V4;
  if (is_v4_or_later) {
    base_meshes.removed_from(cur_mesh_ids, &t.removed_meshes);
  }
  if (is_v5) {
    base_shaders.removed_from(cur_shader_ids, &t.removed_shaders);
    base_materials.removed_from(cur_material_ids, &t.removed_materials);
  }
  // IdIndex walks ascending by id, so removed_* are already ascending.

  for (const CanvasState &canvas : cur.canvases) {
    const CanvasState *prev = base_canvases.find(canvas.id);
    if (prev != nullptr && canvas_state_equal(*prev, canvas)) {
      continue;
    }
    t.canvases.push_back(canvas);
  }

  for (const ItemState &item : cur.items) {
    const ItemState *prev = base_items.find(item.id);
    const bool exists_in_base = prev != nullptr;
    if (exists_in_base && item_state_equal(*prev, item, v10, v11)) {
      continue;
    }
    ItemEntry entry;
    entry.state = item;
    entry.commands_null = exists_in_base && prev->content_version == item.content_version;
    if (entry.commands_null) {
      entry.state.commands.clear();  // not encoded; keeping it empty avoids ambiguity
    }
    t.items.push_back(std::move(entry));
  }

  for (const TextureEntry &tex : cur.textures) {
    const TextureEntry *prev = base_textures.find(tex.id);
    if (prev != nullptr && texture_entry_equal(*prev, tex)) {
      continue;
    }
    t.textures.push_back(tex);
  }

  if (is_v4_or_later) {
    for (const MeshEntry &mesh : cur.meshes) {
      const MeshEntry *prev = base_meshes.find(mesh.id);
      if (prev != nullptr && mesh_entry_equal(*prev, mesh, v11)) {
        continue;
      }
      if (v11 && is_dynamic_mesh(mesh) && !mesh_bodies_needed(prev, mesh)) {
        t.mesh_bodies_held.push_back(mesh.id);  // cur.meshes is ascending, so this is too
      }
      t.meshes.push_back(mesh);
    }
  }

  if (is_v5) {
    for (const ShaderEntry &shader : cur.shaders) {
      const ShaderEntry *prev = base_shaders.find(shader.id);
      if (prev != nullptr && shader_entry_equal(*prev, shader)) {
        continue;
      }
      t.shaders.push_back(shader);
    }
    for (const MaterialEntry &material : cur.materials) {
      const MaterialEntry *prev = base_materials.find(material.id);
      if (prev != nullptr && material_entry_equal(*prev, material)) {
        continue;
      }
      t.materials.push_back(material);
    }
  }

  if (v11 && (!cur.multimeshes.empty() || !base.multimeshes.empty())) {
    // PM1 rules 3 and 9: the entries that are new or differ, or whose buffer the target writes;
    // removed_multimeshes the base ids the target no longer names.
    t.perturb_instance = meta.perturb_instance;
    const IdIndex<MultimeshEntry> base_mms(base.multimeshes);
    const IdIndex<MultimeshEntry> cur_mms(cur.multimeshes);
    base_mms.removed_from(cur_mms, &t.removed_multimeshes);
    for (const MultimeshEntry &mm : cur.multimeshes) {
      const MultimeshEntry *prev = base_mms.find(mm.id);
      const bool buffer = multimesh_buffer_needed(prev, mm);
      if (prev != nullptr && !buffer && multimesh_entry_equal(*prev, mm)) {
        continue;
      }
      if (mm.status == MultimeshStatus::Ok && !buffer) {
        t.multimesh_buffers_held.push_back(mm.id);  // cur.multimeshes is ascending, so this is too
      }
      t.multimeshes.push_back(mm);
    }
  } else if (v11) {
    t.perturb_instance = meta.perturb_instance;
  }

  if (is_v12_or_later(t.version)) {
    // PM5 (render-stream-12.md "Publication", "The emit list"): the entries new or differing
    // since the base, the base ids the target no longer names, and the emits made in host frames
    // (B, T] that the target's tail still holds.
    t.perturb_seed = meta.perturb_seed;
    if (!cur.particles.empty() || !base.particles.empty()) {
      const IdIndex<ParticlesEntry> base_pts(base.particles);
      const IdIndex<ParticlesEntry> cur_pts(cur.particles);
      base_pts.removed_from(cur_pts, &t.removed_particles);
      for (const ParticlesEntry &p : cur.particles) {
        const ParticlesEntry *prev = base_pts.find(p.id);
        if (prev != nullptr && particles_entry_equal(*prev, p)) {
          continue;
        }
        t.particles.push_back(p);
      }
    }
    append_emits(cur.emit_tail, base.frame, cur.frame, &t.particle_emits);
  }

  return t;
}

Snapshot resolve(const Snapshot &base, const Transaction &txn) {
  Snapshot out;
  out.version = txn.version;
  out.seq = txn.seq;
  out.frame = txn.frame;
  out.failures = txn.failures;
  out.unsupported = txn.unsupported;
  out.unknown_items = txn.unknown_items;
  out.shader_time = txn.shader_time;
  out.default_texture_filter = txn.default_texture_filter;
  out.default_texture_repeat = txn.default_texture_repeat;

  // is_v5 means "V5 or later" (see make_patch()'s comment above).
  const bool is_v5 = txn.version == ProtocolVersion::V5 || txn.version == ProtocolVersion::V6 ||
                      txn.version == ProtocolVersion::V7 || txn.version == ProtocolVersion::V8 ||
                      txn.version == ProtocolVersion::V9 || is_v10_or_later(txn.version);
  const bool is_v4_or_later = is_v5 || txn.version == ProtocolVersion::V4;

  if (txn.encoding == Encoding::Full) {
    out.canvases = txn.canvases;
    out.textures = txn.textures;
    if (is_v4_or_later) {
      out.meshes = txn.meshes;
    }
    if (is_v5) {
      out.shaders = txn.shaders;
      out.materials = txn.materials;
    }
    if (is_v11_or_later(txn.version)) {
      out.multimeshes = txn.multimeshes;
    }
    if (is_v12_or_later(txn.version)) {
      out.particles = txn.particles;
    }
    out.items.reserve(txn.items.size());
    for (const ItemEntry &entry : txn.items) {
      out.items.push_back(entry.state);
    }
    return out;
  }

  std::map<std::uint32_t, CanvasState> canvases;
  for (const CanvasState &c : base.canvases) {
    canvases[c.id] = c;
  }
  for (std::uint32_t id : txn.removed_canvases) {
    canvases.erase(id);
  }
  for (const CanvasState &c : txn.canvases) {
    canvases[c.id] = c;
  }

  std::map<std::uint32_t, ItemState> items;
  for (const ItemState &i : base.items) {
    items[i.id] = i;
  }
  for (std::uint32_t id : txn.removed_items) {
    items.erase(id);
  }
  for (const ItemEntry &entry : txn.items) {
    ItemState state = entry.state;
    if (entry.commands_null) {
      auto base_it = items.find(state.id);
      if (base_it != items.end()) {
        state.commands = base_it->second.commands;
      }
    }
    items[state.id] = std::move(state);
  }

  std::map<std::uint32_t, TextureEntry> textures;
  for (const TextureEntry &tex : base.textures) {
    textures[tex.id] = tex;
  }
  for (std::uint32_t id : txn.removed_textures) {
    textures.erase(id);
  }
  for (const TextureEntry &tex : txn.textures) {
    textures[tex.id] = tex;
  }

  std::map<std::uint32_t, MeshEntry> meshes;
  if (is_v4_or_later) {
    for (const MeshEntry &mesh : base.meshes) {
      meshes[mesh.id] = mesh;
    }
    for (std::uint32_t id : txn.removed_meshes) {
      meshes.erase(id);
    }
    for (const MeshEntry &mesh : txn.meshes) {
      meshes[mesh.id] = mesh;
    }
  }

  std::map<std::uint32_t, ShaderEntry> shaders;
  std::map<std::uint32_t, MaterialEntry> materials;
  if (is_v5) {
    for (const ShaderEntry &shader : base.shaders) {
      shaders[shader.id] = shader;
    }
    for (std::uint32_t id : txn.removed_shaders) {
      shaders.erase(id);
    }
    for (const ShaderEntry &shader : txn.shaders) {
      shaders[shader.id] = shader;
    }
    for (const MaterialEntry &material : base.materials) {
      materials[material.id] = material;
    }
    for (std::uint32_t id : txn.removed_materials) {
      materials.erase(id);
    }
    for (const MaterialEntry &material : txn.materials) {
      materials[material.id] = material;
    }
  }

  out.canvases.reserve(canvases.size());
  for (auto &[id, c] : canvases) {
    (void)id;
    out.canvases.push_back(c);
  }
  out.items.reserve(items.size());
  for (auto &[id, i] : items) {
    (void)id;
    out.items.push_back(i);
  }
  out.textures.reserve(textures.size());
  for (auto &[id, tex] : textures) {
    (void)id;
    out.textures.push_back(tex);
  }
  out.meshes.reserve(meshes.size());
  for (auto &[id, mesh] : meshes) {
    (void)id;
    out.meshes.push_back(mesh);
  }
  out.shaders.reserve(shaders.size());
  for (auto &[id, shader] : shaders) {
    (void)id;
    out.shaders.push_back(shader);
  }
  out.materials.reserve(materials.size());
  for (auto &[id, material] : materials) {
    (void)id;
    out.materials.push_back(material);
  }
  if (is_v12_or_later(txn.version)) {
    // PM5: as the multimesh table (a listed entry always carries its floats).
    std::map<std::uint32_t, ParticlesEntry> pts;
    for (const ParticlesEntry &p : base.particles) {
      pts[p.id] = p;
    }
    for (std::uint32_t id : txn.removed_particles) {
      pts.erase(id);
    }
    for (const ParticlesEntry &p : txn.particles) {
      pts[p.id] = p;
    }
    out.particles.reserve(pts.size());
    for (auto &[id, p] : pts) {
      (void)id;
      out.particles.push_back(p);
    }
  }
  if (is_v11_or_later(txn.version)) {
    // PM1: as the mesh table; an entry whose buffer_f is null keeps the floats the base held,
    // which a capture's entry already carries (its buffer pointer is the target's own).
    std::map<std::uint32_t, MultimeshEntry> mms;
    for (const MultimeshEntry &mm : base.multimeshes) {
      mms[mm.id] = mm;
    }
    for (std::uint32_t id : txn.removed_multimeshes) {
      mms.erase(id);
    }
    for (const MultimeshEntry &mm : txn.multimeshes) {
      mms[mm.id] = mm;
    }
    out.multimeshes.reserve(mms.size());
    for (auto &[id, mm] : mms) {
      (void)id;
      out.multimeshes.push_back(mm);
    }
  }
  return out;
}

namespace {

template <typename T>
bool float_vectors_equal_bits(const std::vector<T> &a, const std::vector<T> &b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (!arrays_equal_bits(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

bool command_equal_bits(const Command &a, const Command &b) {
  return a.kind == b.kind && a.antialiased == b.antialiased && a.has_tex == b.has_tex &&
         a.tex == b.tex && a.tile == b.tile && a.transpose == b.transpose &&
         a.clip_uv == b.clip_uv && arrays_equal_bits(a.rect, b.rect) &&
         arrays_equal_bits(a.src, b.src) && arrays_equal_bits(a.color, b.color) &&
         arrays_equal_bits(a.modulate, b.modulate) && a.name == b.name &&
         a.unsupported_reason == b.unsupported_reason && a.msdf_outline == b.msdf_outline &&
         floats_equal_bits(a.msdf_px_range, b.msdf_px_range) &&
         floats_equal_bits(a.msdf_scale, b.msdf_scale) &&
         arrays_equal_bits(a.line_from, b.line_from) && arrays_equal_bits(a.line_to, b.line_to) &&
         floats_equal_bits(a.width, b.width) && float_vectors_equal_bits(a.points, b.points) &&
         float_vectors_equal_bits(a.colors, b.colors) && float_vectors_equal_bits(a.uvs, b.uvs) &&
         a.indices == b.indices && a.triangle_count == b.triangle_count &&
         arrays_equal_bits(a.circle_position, b.circle_position) &&
         floats_equal_bits(a.circle_radius, b.circle_radius) &&
         arrays_equal_bits(a.np_margin_tl, b.np_margin_tl) &&
         arrays_equal_bits(a.np_margin_br, b.np_margin_br) && a.x_axis == b.x_axis &&
         a.y_axis == b.y_axis && a.draw_center == b.draw_center && a.mesh == b.mesh &&
         arrays_equal_bits(a.transform, b.transform) && a.clip_ignore == b.clip_ignore &&
         a.multimesh == b.multimesh && a.particles == b.particles;
}

}  // namespace

// Tripwire: a field added to Command must join command_equal_bits above (a field left out could
// keep a stale /11 digest and command list). Update the size here once it does.
#if defined(__x86_64__) && defined(__GLIBCXX__)
static_assert(sizeof(Command) == 328, "Command changed: update command_equal_bits, then this size");
#endif

bool command_lists_equal_bits(const std::vector<Command> &a, const std::vector<Command> &b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (std::size_t i = 0; i < a.size(); ++i) {
    if (!command_equal_bits(a[i], b[i])) {
      return false;
    }
  }
  return true;
}

bool lower_multimesh_commands(const std::vector<Command> &commands, std::vector<Command> *out) {
  bool any = false;
  for (const Command &command : commands) {
    if (lowers(command)) {
      any = true;
      break;
    }
  }
  if (!any) {
    return false;
  }
  out->clear();
  out->reserve(commands.size());
  for (const Command &command : commands) {
    if (!lowers(command)) {
      out->push_back(command);
      continue;
    }
    Command lowered;
    lowered.kind = CommandKind::Unsupported;
    lowered.name = kAddMultimeshOp;
    lowered.unsupported_reason = UnsupportedCmdReason::UnsupportedOp;
    out->push_back(std::move(lowered));
  }
  return true;
}

Snapshot lower_multimesh(const Snapshot &state) {
  Snapshot out = state;
  out.multimeshes.clear();
  if (!state.multimesh_commands) {
    return out;
  }
  out.multimesh_commands = false;
  std::vector<std::uint32_t> drawing;  // the items drawing a lowered command, ascending
  for (ItemState &item : out.items) {
    std::vector<Command> lowered;
    if (!lower_multimesh_commands(item.commands.vector(), &lowered)) {
      continue;
    }
    item.commands = std::move(lowered);
    if (item.content_version_below_v11 != 0) {
      item.content_version = item.content_version_below_v11;
    }
    drawing.push_back(item.id);
  }
  std::vector<UnsupportedRef> session_level;
  std::vector<UnsupportedRef> item_level;
  for (const UnsupportedRef &ref : out.unsupported) {
    if (!ref.has_item) {
      session_level.push_back(ref);
    } else if (ref.op != kAddMultimeshOp) {
      item_level.push_back(ref);
    }
  }
  for (std::uint32_t id : drawing) {
    UnsupportedRef ref;
    ref.op = kAddMultimeshOp;
    ref.has_item = true;
    ref.item = id;
    ref.reason = UnsupportedReason::UnsupportedOp;
    item_level.push_back(std::move(ref));
  }
  // The mirror's order (rs_mirror.cpp snapshot()): item id, then op, then reason, byte order.
  std::stable_sort(item_level.begin(), item_level.end(),
                   [](const UnsupportedRef &a, const UnsupportedRef &b) {
                     if (a.item != b.item) {
                       return a.item < b.item;
                     }
                     if (a.op != b.op) {
                       return a.op < b.op;
                     }
                     return std::string(to_wire(a.reason)) < std::string(to_wire(b.reason));
                   });
  out.unsupported = std::move(session_level);
  out.unsupported.insert(out.unsupported.end(), item_level.begin(), item_level.end());
  return out;
}

namespace {

void insert_sorted(std::vector<std::string> *list, const char *name) {
  if (std::find(list->begin(), list->end(), name) == list->end()) {
    list->insert(std::lower_bound(list->begin(), list->end(), std::string(name)), name);
  }
}

void erase_name(std::vector<std::string> *list, const char *name) {
  const auto it = std::find(list->begin(), list->end(), name);
  if (it != list->end()) {
    list->erase(it);
  }
}

}  // namespace

bool lower_particles_commands(const std::vector<Command> &commands, std::vector<Command> *out) {
  bool any = false;
  for (const Command &command : commands) {
    if (lowers_particles(command)) {
      any = true;
      break;
    }
  }
  if (!any) {
    return false;
  }
  out->clear();
  out->reserve(commands.size());
  for (const Command &command : commands) {
    if (!lowers_particles(command)) {
      out->push_back(command);
      continue;
    }
    Command lowered;
    lowered.kind = CommandKind::Unsupported;
    lowered.name = kAddParticlesOp;
    lowered.unsupported_reason = UnsupportedCmdReason::UnsupportedOp;
    out->push_back(std::move(lowered));
  }
  return true;
}

bool lower_v11_commands(const std::vector<Command> &commands, std::vector<Command> *out) {
  std::vector<Command> particles_lowered;
  const bool particles = lower_particles_commands(commands, &particles_lowered);
  const std::vector<Command> &in = particles ? particles_lowered : commands;
  std::vector<Command> both;
  if (lower_multimesh_commands(in, &both)) {
    *out = std::move(both);
    return true;
  }
  if (particles) {
    *out = std::move(particles_lowered);
    return true;
  }
  return false;
}

Snapshot lower_particles(const Snapshot &state) {
  Snapshot out = state;
  out.particles.clear();
  out.emit_tail.reset();
  if (!state.particles_commands) {
    return out;
  }
  out.particles_commands = false;
  for (ShaderEntry &shader : out.shaders) {
    if (shader.below_v12 != nullptr) {
      const std::shared_ptr<const ShaderEntry> below = shader.below_v12;
      shader = *below;
    }
    shader.has_ppm = false;
  }
  for (MaterialEntry &material : out.materials) {
    if (material.below_v12 != nullptr) {
      const std::shared_ptr<const MaterialEntry> below = material.below_v12;
      material = *below;
    }
  }
  if (out.shader_time.has_value()) {
    // The host's shader time travels only when an `ok` shader reads TIME (render-stream-10.md);
    // a process-material shader that is `ok` only at /12 does not count below it.
    bool read = false;
    for (const ShaderEntry &shader : out.shaders) {
      read = read || (shader.status == ShaderStatus::Ok &&
                      std::find(shader.uses.begin(), shader.uses.end(), ShaderUse::Time) !=
                          shader.uses.end());
    }
    if (!read) {
      out.shader_time.reset();
    }
  }
  std::vector<std::uint32_t> drawing;  // the items drawing a lowered command, ascending
  for (ItemState &item : out.items) {
    std::vector<Command> lowered;
    if (!lower_particles_commands(item.commands.vector(), &lowered)) {
      continue;
    }
    item.commands = std::move(lowered);
    if (item.content_version_below_v12 != 0) {
      item.content_version = item.content_version_below_v12;
    }
    drawing.push_back(item.id);
  }
  if (drawing.empty()) {
    return out;  // only shader/material forms differed: the unsupported list is /11's already
  }
  std::vector<UnsupportedRef> session_level;
  std::vector<UnsupportedRef> item_level;
  for (const UnsupportedRef &ref : out.unsupported) {
    if (!ref.has_item) {
      session_level.push_back(ref);
    } else if (ref.op != kAddParticlesOp) {
      item_level.push_back(ref);
    }
  }
  for (std::uint32_t id : drawing) {
    UnsupportedRef ref;
    ref.op = kAddParticlesOp;
    ref.has_item = true;
    ref.item = id;
    ref.reason = UnsupportedReason::UnsupportedOp;
    item_level.push_back(std::move(ref));
  }
  // The mirror's order (rs_mirror.cpp snapshot()): item id, then op, then reason, byte order.
  std::stable_sort(item_level.begin(), item_level.end(),
                   [](const UnsupportedRef &a, const UnsupportedRef &b) {
                     if (a.item != b.item) {
                       return a.item < b.item;
                     }
                     if (a.op != b.op) {
                       return a.op < b.op;
                     }
                     return std::string(to_wire(a.reason)) < std::string(to_wire(b.reason));
                   });
  out.unsupported = std::move(session_level);
  out.unsupported.insert(out.unsupported.end(), item_level.begin(), item_level.end());
  return out;
}

void observe_multimesh_features(Features *features) {
  insert_sorted(&features->ops, "add_multimesh");
  insert_sorted(&features->resources, "multimesh");
  erase_name(&features->observed_unsupported_ops, kAddMultimeshOp);
}

void unobserve_multimesh_features(Features *features) {
  erase_name(&features->ops, "add_multimesh");
  erase_name(&features->resources, "multimesh");
  insert_sorted(&features->observed_unsupported_ops, kAddMultimeshOp);
}

void observe_particles_features(Features *features) {
  insert_sorted(&features->ops, "add_particles");
  insert_sorted(&features->resources, "particles");
  erase_name(&features->observed_unsupported_ops, kAddParticlesOp);
}

void unobserve_particles_features(Features *features) {
  erase_name(&features->ops, "add_particles");
  erase_name(&features->resources, "particles");
  insert_sorted(&features->observed_unsupported_ops, kAddParticlesOp);
}

namespace {

// names(S) as payload_names() describes, with or without the texture variants.
std::vector<PayloadName> collect_names(const Snapshot &state, bool variants) {
  std::vector<PayloadName> out;
  std::set<std::string> seen;
  const auto add = [&](const std::string &hash, std::uint64_t bytes) {
    if (!hash.empty() && seen.insert(hash).second) {
      out.push_back(PayloadName{hash, bytes});
    }
  };
  for (const TextureEntry &t : state.textures) {
    if (t.kind != TextureKind::Image || t.status != TextureStatus::Ok) {
      continue;
    }
    if (t.has_hash) {
      add(t.hash, t.payload_bytes);
    }
    for (std::size_t i = 0; variants && i < t.variants.size(); ++i) {
      add(t.variants[i].hash, t.variants[i].payload_bytes);
    }
  }
  for (const MeshEntry &m : state.meshes) {
    if (m.status != MeshStatus::Ok || is_dynamic_mesh(m)) {
      continue;  // a dynamic surface has no hash and is not in names(S)
    }
    for (const MeshSurface &surface : m.surfaces) {
      add(surface.hash, surface.payload_bytes);
    }
  }
  for (const ShaderEntry &sh : state.shaders) {
    if (sh.status == ShaderStatus::Ok && sh.has_source && sh.source == ShaderSource::Payload &&
        sh.has_hash) {
      add(sh.hash, sh.payload_bytes);
    }
  }
  return out;
}

}  // namespace

std::vector<PayloadName> payload_names(const Snapshot &state) {
  return collect_names(state, true);
}

std::vector<PayloadName> inline_names(const Snapshot &state, const InlinePolicy &policy) {
  std::vector<PayloadName> out = collect_names(state, policy.inline_variants);
  out.erase(std::remove_if(out.begin(), out.end(),
                           [&](const PayloadName &n) {
                             return n.payload_bytes > policy.inline_max_bytes;
                           }),
            out.end());
  return out;
}

std::vector<PayloadName> records_before(const Snapshot *base, const Snapshot &target,
                                        const InlinePolicy &policy) {
  std::vector<PayloadName> out = inline_names(target, policy);
  if (base == nullptr) {
    return out;
  }
  std::set<std::string> held;
  for (PayloadName &name : inline_names(*base, policy)) {
    held.insert(std::move(name.hash));
  }
  out.erase(std::remove_if(out.begin(), out.end(),
                           [&](const PayloadName &n) { return held.count(n.hash) != 0; }),
            out.end());
  return out;
}

std::vector<PayloadName> RecordPlanner::next(const Snapshot *base, const Snapshot &target) {
  if (!lifelong_) {
    return records_before(base, target, policy_);
  }
  std::vector<PayloadName> out;
  for (PayloadName &name : inline_names(target, policy_)) {
    const auto at = std::lower_bound(carried_.begin(), carried_.end(), name.hash);
    if (at != carried_.end() && *at == name.hash) {
      continue;
    }
    carried_.insert(at, name.hash);
    out.push_back(std::move(name));
  }
  return out;
}

}  // namespace rs2
}  // namespace grc
