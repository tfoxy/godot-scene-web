#include "rs2_diff.h"

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

// render-stream-1.md "Patch transactions", unchanged at /2: "An entry differs when any JSON
// value or any of its block floats differs; floats compare by their 32-bit pattern. `commands`
// do not take part in the comparison; `content_version` stands for them." texture_filter/
// texture_repeat are new JSON fields that participate like any other.
// gate5_5-design.md D9: "material, use_parent_material and instance_params are item state, never
// content_version" -- they participate here unconditionally, exactly like texture_filter/
// texture_repeat, never exempted by a content_version match the way `commands` is.
bool item_state_equal(const ItemState &a, const ItemState &b) {
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
  Transaction t;
  t.version = cur.version;
  t.seq = cur.seq;
  t.frame = cur.frame;
  t.encoding = Encoding::Full;
  t.base_seq.reset();
  t.failures = cur.failures;
  t.unsupported = cur.unsupported;
  t.unknown_items = cur.unknown_items;
  t.default_texture_filter = cur.default_texture_filter;
  t.default_texture_repeat = cur.default_texture_repeat;
  t.canvases = cur.canvases;
  t.textures = cur.textures;
  if (cur.version == ProtocolVersion::V4 || cur.version == ProtocolVersion::V5 ||
      cur.version == ProtocolVersion::V6 || cur.version == ProtocolVersion::V7 ||
      cur.version == ProtocolVersion::V8 || cur.version == ProtocolVersion::V9) {
    t.meshes = cur.meshes;
  }
  if (cur.version == ProtocolVersion::V5 || cur.version == ProtocolVersion::V6 ||
      cur.version == ProtocolVersion::V7 || cur.version == ProtocolVersion::V8 ||
      cur.version == ProtocolVersion::V9) {
    t.shaders = cur.shaders;
    t.materials = cur.materials;
  }
  t.items.reserve(cur.items.size());
  for (const ItemState &item : cur.items) {
    t.items.push_back(full_entry(item));
  }
  return t;
}

Transaction make_patch(const Snapshot &base, const Snapshot &cur) {
  Transaction t;
  t.version = cur.version;
  t.seq = cur.seq;
  t.frame = cur.frame;
  t.encoding = Encoding::Patch;
  t.base_seq = base.seq;
  t.failures = cur.failures;
  t.unsupported = cur.unsupported;
  t.unknown_items = cur.unknown_items;
  t.default_texture_filter = cur.default_texture_filter;
  t.default_texture_repeat = cur.default_texture_repeat;

  std::map<std::uint32_t, const CanvasState *> base_canvases;
  for (const CanvasState &c : base.canvases) {
    base_canvases[c.id] = &c;
  }
  std::map<std::uint32_t, const ItemState *> base_items;
  for (const ItemState &i : base.items) {
    base_items[i.id] = &i;
  }
  std::map<std::uint32_t, const TextureEntry *> base_textures;
  for (const TextureEntry &tex : base.textures) {
    base_textures[tex.id] = &tex;
  }
  std::map<std::uint32_t, const MeshEntry *> base_meshes;
  for (const MeshEntry &mesh : base.meshes) {
    base_meshes[mesh.id] = &mesh;
  }
  std::map<std::uint32_t, const ShaderEntry *> base_shaders;
  for (const ShaderEntry &shader : base.shaders) {
    base_shaders[shader.id] = &shader;
  }
  std::map<std::uint32_t, const MaterialEntry *> base_materials;
  for (const MaterialEntry &material : base.materials) {
    base_materials[material.id] = &material;
  }
  std::set<std::uint32_t> cur_canvas_ids;
  for (const CanvasState &c : cur.canvases) {
    cur_canvas_ids.insert(c.id);
  }
  std::set<std::uint32_t> cur_item_ids;
  for (const ItemState &i : cur.items) {
    cur_item_ids.insert(i.id);
  }
  std::set<std::uint32_t> cur_texture_ids;
  for (const TextureEntry &tex : cur.textures) {
    cur_texture_ids.insert(tex.id);
  }
  std::set<std::uint32_t> cur_mesh_ids;
  for (const MeshEntry &mesh : cur.meshes) {
    cur_mesh_ids.insert(mesh.id);
  }
  std::set<std::uint32_t> cur_shader_ids;
  for (const ShaderEntry &shader : cur.shaders) {
    cur_shader_ids.insert(shader.id);
  }
  std::set<std::uint32_t> cur_material_ids;
  for (const MaterialEntry &material : cur.materials) {
    cur_material_ids.insert(material.id);
  }

  for (const auto &[id, ptr] : base_canvases) {
    (void)ptr;
    if (cur_canvas_ids.find(id) == cur_canvas_ids.end()) {
      t.removed_canvases.push_back(id);
    }
  }
  for (const auto &[id, ptr] : base_items) {
    (void)ptr;
    if (cur_item_ids.find(id) == cur_item_ids.end()) {
      t.removed_items.push_back(id);
    }
  }
  for (const auto &[id, ptr] : base_textures) {
    (void)ptr;
    if (cur_texture_ids.find(id) == cur_texture_ids.end()) {
      t.removed_textures.push_back(id);
    }
  }
  // is_v5 means "V5 or later" (render-stream-6.md/-7.md are a delta on /5's tables, carrying
  // its shader/material tables and mesh table forward unchanged).
  const bool is_v5 = cur.version == ProtocolVersion::V5 || cur.version == ProtocolVersion::V6 ||
                      cur.version == ProtocolVersion::V7 || cur.version == ProtocolVersion::V8 ||
                      cur.version == ProtocolVersion::V9;
  const bool is_v4_or_later = is_v5 || cur.version == ProtocolVersion::V4;
  if (is_v4_or_later) {
    for (const auto &[id, ptr] : base_meshes) {
      (void)ptr;
      if (cur_mesh_ids.find(id) == cur_mesh_ids.end()) {
        t.removed_meshes.push_back(id);
      }
    }
  }
  if (is_v5) {
    for (const auto &[id, ptr] : base_shaders) {
      (void)ptr;
      if (cur_shader_ids.find(id) == cur_shader_ids.end()) {
        t.removed_shaders.push_back(id);
      }
    }
    for (const auto &[id, ptr] : base_materials) {
      (void)ptr;
      if (cur_material_ids.find(id) == cur_material_ids.end()) {
        t.removed_materials.push_back(id);
      }
    }
  }
  // std::map iterates ascending by key, so removed_* are already ascending.

  for (const CanvasState &canvas : cur.canvases) {
    auto it = base_canvases.find(canvas.id);
    if (it != base_canvases.end() && canvas_state_equal(*it->second, canvas)) {
      continue;
    }
    t.canvases.push_back(canvas);
  }

  for (const ItemState &item : cur.items) {
    auto it = base_items.find(item.id);
    const bool exists_in_base = it != base_items.end();
    if (exists_in_base && item_state_equal(*it->second, item)) {
      continue;
    }
    ItemEntry entry;
    entry.state = item;
    entry.commands_null = exists_in_base && it->second->content_version == item.content_version;
    if (entry.commands_null) {
      entry.state.commands.clear();  // not encoded; keeping it empty avoids ambiguity
    }
    t.items.push_back(std::move(entry));
  }

  for (const TextureEntry &tex : cur.textures) {
    auto it = base_textures.find(tex.id);
    if (it != base_textures.end() && texture_entry_equal(*it->second, tex)) {
      continue;
    }
    t.textures.push_back(tex);
  }

  if (is_v4_or_later) {
    for (const MeshEntry &mesh : cur.meshes) {
      auto it = base_meshes.find(mesh.id);
      if (it != base_meshes.end() && mesh_entry_equal(*it->second, mesh)) {
        continue;
      }
      t.meshes.push_back(mesh);
    }
  }

  if (is_v5) {
    for (const ShaderEntry &shader : cur.shaders) {
      auto it = base_shaders.find(shader.id);
      if (it != base_shaders.end() && shader_entry_equal(*it->second, shader)) {
        continue;
      }
      t.shaders.push_back(shader);
    }
    for (const MaterialEntry &material : cur.materials) {
      auto it = base_materials.find(material.id);
      if (it != base_materials.end() && material_entry_equal(*it->second, material)) {
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
  out.default_texture_filter = txn.default_texture_filter;
  out.default_texture_repeat = txn.default_texture_repeat;

  // is_v5 means "V5 or later" (see make_patch()'s comment above).
  const bool is_v5 = txn.version == ProtocolVersion::V5 || txn.version == ProtocolVersion::V6 ||
                      txn.version == ProtocolVersion::V7 || txn.version == ProtocolVersion::V8 ||
                      txn.version == ProtocolVersion::V9;
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
