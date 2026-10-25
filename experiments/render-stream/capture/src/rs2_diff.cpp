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

bool item_state_equal(const ItemState &a, const ItemState &b, bool v10) {
  if (v10 && !backbuffer_state_equal(a, b)) {
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
bool mesh_surface_equal(const MeshSurface &a, const MeshSurface &b) {
  return a.hash == b.hash && a.payload_bytes == b.payload_bytes && a.primitive == b.primitive &&
         a.format == b.format && a.vertex_count == b.vertex_count && a.index_count == b.index_count;
}

// render-stream-4.md "Mesh table": "exactly the texture table's full/patch/resolve semantics",
// so every JSON field participates (no content_version-style exemption, same as textures).
bool mesh_entry_equal(const MeshEntry &a, const MeshEntry &b) {
  if (a.origin != b.origin || a.adopted_content != b.adopted_content) {
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
      t.version == ProtocolVersion::V10) {
    t.meshes = cur.meshes;
  }
  if (t.version == ProtocolVersion::V5 || t.version == ProtocolVersion::V6 ||
      t.version == ProtocolVersion::V7 || t.version == ProtocolVersion::V8 ||
      t.version == ProtocolVersion::V9 || t.version == ProtocolVersion::V10) {
    t.shaders = cur.shaders;
    t.materials = cur.materials;
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
  const bool v10 = t.version == ProtocolVersion::V10;
  // is_v5 means "V5 or later" (render-stream-6.md/-7.md are a delta on /5's tables, carrying
  // its shader/material tables and mesh table forward unchanged).
  const bool is_v5 = t.version == ProtocolVersion::V5 || t.version == ProtocolVersion::V6 ||
                      t.version == ProtocolVersion::V7 || t.version == ProtocolVersion::V8 ||
                      t.version == ProtocolVersion::V9 || t.version == ProtocolVersion::V10;
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
    if (exists_in_base && item_state_equal(*prev, item, v10)) {
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
      if (prev != nullptr && mesh_entry_equal(*prev, mesh)) {
        continue;
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
                      txn.version == ProtocolVersion::V9 || txn.version == ProtocolVersion::V10;
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
  return out;
}

}  // namespace rs2
}  // namespace grc
