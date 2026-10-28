// Unit tests for render-stream/11 (src/rs2_codec.cpp's and rs2_diff.cpp's version == V11 path,
// W11a).
//
// render-stream/11 is a protocol-version switch inside the SAME rs2_codec/rs2_diff modules /2-/10
// use (render-stream-11.md), so this file proves only /11's delta by matching
// protocol/golden-11/{full,patch,inline}.rs11 byte for byte: the GRSB magic and the
// "render-stream/11" protocol string, the session key resources.mesh_dynamic, dynamic mesh
// surfaces (`hash: null`, the entry key `u8` and the eighth block `mesh_u8`, with make_patch()'s
// serial rule deciding a null `u8`), the empty ninth block `mm_f32`, a patched `unsupported` (null
// when it equals the base's) and the resource records as a function of (B, T) alone
// (rs2_diff.h records_before(), RecordPlanner): inline.rs11's records come from RecordPlanner only.
// With the keep-carried flag the same inline stream is exactly invalid/resource-missing.rs11.
//
// The sixteen states mirror protocol/golden-11/make_golden.py: golden-10's ten states (state10()
// below, copied from rs10_codec_test.cpp, which copied golden-9's from rs9_codec_test.cpp) plus
// six /11 states built here (state11()).

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"

#ifndef GRC_GOLDEN6_DIR
#error "GRC_GOLDEN6_DIR must be defined by CMakeLists.txt"
#endif
#ifndef GRC_GOLDEN10_DIR
#error "GRC_GOLDEN10_DIR must be defined by CMakeLists.txt"
#endif
#ifndef GRC_GOLDEN11_DIR
#error "GRC_GOLDEN11_DIR must be defined by CMakeLists.txt"
#endif

namespace {

using namespace grc::rs2;  // NOLINT

using namespace grc::rs2;  // NOLINT

int g_failures = 0;
constexpr int kStates = 23;  // golden-11's states (make_golden.py STATES)

void check(bool condition, const char *what) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s\n", what);
    ++g_failures;
  }
}

std::vector<std::uint8_t> read_file(const std::string &path) {
  std::FILE *file = std::fopen(path.c_str(), "rb");
  if (file == nullptr) {
    return {};
  }
  std::vector<std::uint8_t> data;
  unsigned char buf[4096];
  std::size_t n = 0;
  while ((n = std::fread(buf, 1, sizeof(buf), file)) > 0) {
    data.insert(data.end(), buf, buf + n);
  }
  std::fclose(file);
  return data;
}

void check_against_golden(const std::string &file,
                          const std::vector<std::vector<std::uint8_t>> &records) {
  const std::vector<std::uint8_t> expected = read_file(std::string(GRC_GOLDEN11_DIR) + "/" + file);
  check(!expected.empty(), ("golden-11/" + file + " is readable").c_str());
  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-11/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(),
        ("encoded recording is exactly golden-11/" + file + "'s length").c_str());
}

End make_end(std::uint64_t full_count, std::uint64_t patch_count, std::uint64_t diff_ns_total,
             std::uint64_t resource_records, std::uint64_t resource_bytes,
             const std::vector<std::vector<std::uint8_t>> &records) {
  End end;
  end.transactions = full_count + patch_count;
  end.reason = EndReason::Shutdown;
  end.stats.encode_ns_total = 250000;
  end.stats.snapshot_ns_total = 40000;
  end.stats.diff_ns_total = diff_ns_total;
  end.stats.full_transactions = full_count;
  end.stats.patch_transactions = patch_count;
  end.stats.resource_records = resource_records;
  end.stats.resource_bytes = resource_bytes;
  std::uint64_t bytes_total = 0;
  std::uint64_t max_len = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    bytes_total += records[i].size();
    if (i > 0) {
      max_len = std::max<std::uint64_t>(max_len, records[i].size());
    }
  }
  end.stats.bytes_total = bytes_total;
  end.stats.max_record_bytes = max_len;
  return end;
}

// protocol/golden-9/make_golden.py's payload hashes and whole-payload lengths (the index.json's
// "payloads", "mesh_payloads" and "shader_payloads").
const std::string kHashDec = "71b311777cc9812b1443591ca77bc8a8186b5269adc10fca7aff5c4818f9e510";
const std::string kHashRgbaf = "9ecc93d4dea0bb489a9801d18d92f58d1095d88cc976d50029c1a21fd195f48e";
const std::string kHashRh = "d689749c279ef7eb9c13091e1703669d24a69332b06c8b93d8253dad122256a2";
const std::string kHashMesh1A = "42532dc3a4f775e3426da84ca155a52da8b598594a396e68f364e1b220aa933a";
const std::string kHashMesh1B = "4353a1d85e83235c0041d2563ae73b0e54dfe6f37f7a859a5acb88aedae49474";
const std::string kHashShader = "2c874800cd97ba181708fd009b2ec9ab5c49e666c285a39427cf5f8ccf761310";

// golden-9's new payloads (index.json "payloads" and "ktx2_payloads").
const std::string kHashMip16 = "4285398666ce2fb9864bf79a22850c62f303b11d44f2f2811c96f77aa86f5501";
const std::string kHashDxt5x4 = "77810bae65da7b6d99e913b2c9a73d1f11d4d2fd4b4c4e2b3c36fccf20e1f6ba";
const std::string kHashDxt5x16m = "c5389bc4c39e22a05e572659b3a045dbc76d8d88bb19ce177a0cd61c3b8f48b6";
const std::string kHashKtx16 = "6fd80d9eb05486515b8bc16d087d412cf73d9ea7dbe033cc9b01a4d8a6683f22";
const std::string kHashKtx4 = "75fbf2c59e1204746839864e287467d049762bfbefd43add6a4eb2b7a1bd2203";
const char *const kParamsUastc = "basisu-1.60/uastc-l1/zstd6/linear";

TextureVariant block_variant(const std::string &hash, std::uint64_t bytes, const char *format) {
  TextureVariant v;
  v.encoding = VariantEncoding::Block;
  v.hash = hash;
  v.payload_bytes = bytes;
  v.has_format = true;
  v.format = format;
  return v;
}

TextureVariant uastc_variant(const std::string &hash, std::uint64_t bytes) {
  TextureVariant v;
  v.encoding = VariantEncoding::Uastc;
  v.hash = hash;
  v.payload_bytes = bytes;
  v.has_params = true;
  v.params = kParamsUastc;
  return v;
}

TextureEntry image(std::uint32_t id, const std::string &hash, const char *format, int w, int h,
                   bool mipmaps, std::uint64_t payload_bytes, std::uint64_t version = 1) {
  TextureEntry t;
  t.id = id;
  t.kind = TextureKind::Image;
  t.version = version;
  t.has_hash = true;
  t.hash = hash;
  t.has_format = true;
  t.format = format;
  t.width = w;
  t.height = h;
  t.mipmaps = mipmaps;
  t.payload_bytes = payload_bytes;
  return t;
}

TextureEntry adopt(TextureEntry t, AdoptedContent content) {
  t.origin = Origin::Adopted;
  t.adopted_content = content;
  return t;
}

TextureEntry decoded(TextureEntry t, const char *source_format) {
  t.has_source_format = true;
  t.source_format = source_format;
  return t;
}

CanvasState canvas2() {
  CanvasState c;
  c.id = 2;
  c.origin = Origin::Adopted;
  c.role = CanvasRole::None;
  c.attached = true;
  c.layer = 1;
  c.sublayer = 0;
  c.xform = {1.0f, 0.0f, 0.0f, 1.0f, 10.0f, 10.0f};
  c.items = {7};
  return c;
}

ItemState item6() {
  ItemState it;
  it.id = 6;
  it.origin = Origin::Adopted;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 100.0f, 0.0f};
  it.draw_index = 5;
  it.content_version = 1;
  it.commands = {golden::add_texture_rect(true, 6, false, false, {0.0f, 0.0f, 16.0f, 16.0f}),
                 golden::add_texture_rect(true, 9, false, false, {16.0f, 0.0f, 8.0f, 8.0f})};
  return it;
}

ItemState item7() {
  ItemState it;
  it.id = 7;
  it.origin = Origin::Adopted;
  it.parent = ParentRef{ParentKind::Canvas, 2};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 40.0f};
  it.draw_index = 0;
  it.content_version = 1;
  it.has_material = true;
  it.material = 1;
  it.commands = {golden::add_rect({0.0f, 0.0f, 24.0f, 24.0f}, {0.5f, 0.5f, 1.0f, 1.0f})};
  return it;
}

ItemState item8() {
  ItemState it;
  it.id = 8;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, 130.0f, 0.0f};
  it.draw_index = 6;
  it.content_version = 1;
  it.commands = {golden::add_texture_rect(true, 7, false, false, {0.0f, 0.0f, 8.0f, 8.0f}),
                 golden::add_texture_rect(true, 8, false, false, {8.0f, 0.0f, 8.0f, 8.0f}),
                 golden::add_texture_rect(true, 10, false, false, {16.0f, 0.0f, 8.0f, 8.0f}),
                 golden::add_mesh(1, kIdentityXform)};
  return it;
}

// golden-8's six states (n <= 6) at /9, then golden-9's states 7 and 8.
Snapshot state9(int n) {
  const int m = n <= 6 ? n : 6;
  Snapshot s = golden::state(m <= 3 ? m : 3);
  s.version = ProtocolVersion::V9;
  s.seq = static_cast<std::uint64_t>(n);
  s.frame = static_cast<std::uint64_t>(n);
  if (m <= 3) {
    return s;
  }
  s.textures.push_back(adopt(image(6, golden::kHashA1, "RGBA8", 16, 16, false, 1135),
                             AdoptedContent::Creation));
  s.textures.push_back(decoded(image(7, kHashDec, "RGBA8", 4, 4, false, 171), "DXT5"));
  s.textures.push_back(image(8, kHashRgbaf, "RGBAF", 2, 2, false, 171));
  s.textures.push_back(adopt(image(9, kHashRh, "RH", 3, 2, true, 117), AdoptedContent::Current));
  s.textures.push_back(decoded(adopt(image(10, kHashDec, "RGBA8", 4, 4, false, 171),
                                     AdoptedContent::Creation),
                               "BPTC_RGBA"));
  MeshEntry mesh = golden::mesh_entry(
      MeshStatus::Ok, 1,
      {golden::mesh_surface(kHashMesh1A, 256, Primitive::Triangles, golden::kMesh1SurfaceAFormat,
                            3, 0)});
  mesh.id = 1;
  mesh.origin = Origin::Adopted;
  mesh.adopted_content = AdoptedContent::Creation;
  s.meshes = {mesh};
  ShaderEntry shader = golden::shader_entry(ShaderStatus::Ok, 1, kHashShader, 157);
  shader.id = 1;
  shader.origin = Origin::Adopted;
  s.shaders = {shader};
  MaterialEntry material = golden::material_entry(
      MaterialStatus::Ok, 1, true, 1,
      {golden::make_param("tex_a", VariantType::Rid, {}, 1, true, 6),
       golden::make_param("tint", VariantType::Color, {1.0, 0.5, 0.25, 1.0})});
  material.id = 1;
  material.origin = Origin::Adopted;
  s.materials = {material};
  s.items.push_back(item6());
  s.items.push_back(item7());
  s.items.push_back(item8());
  s.canvases = {golden::root_canvas({1, 2, 3, 4, 5, 6, 8}), canvas2()};
  if (m >= 5) {
    s.textures[5].version = 2;
    s.textures[5].hash = golden::kHashA2;
    s.textures[5].payload_bytes = 1135;
    s.textures[5].adopted_content = AdoptedContent::Current;
    s.meshes[0].version = 2;
    s.meshes[0].adopted_content = AdoptedContent::Current;
    s.meshes[0].surfaces = {golden::mesh_surface(kHashMesh1B, 297, Primitive::Triangles,
                                                 golden::kMesh1SurfaceBFormat, 4, 6)};
  }
  if (m >= 6) {
    s.items.erase(std::remove_if(s.items.begin(), s.items.end(),
                                 [](const ItemState &it) { return it.id == 6; }),
                  s.items.end());
    s.canvases[0] = golden::root_canvas({1, 2, 3, 4, 5, 8});
    TextureEntry freed;
    freed.id = 10;
    freed.origin = Origin::Adopted;
    freed.adopted_content = AdoptedContent::Creation;
    freed.kind = TextureKind::Image;
    freed.status = TextureStatus::Freed;
    freed.version = 2;
    s.textures[9] = freed;
  }
  if (n >= 7) {
    s.textures[6].variants = {block_variant(kHashDxt5x4, 122, "DXT5")};
    TextureEntry mip = image(11, kHashMip16, "RGBA8", 16, 16, true, 1474);
    mip.variants = {block_variant(kHashDxt5x16m, 476, "DXT5")};
    s.textures.push_back(mip);
    ItemState it9;
    it9.id = 9;
    it9.parent = ParentRef{ParentKind::Canvas, 1};
    it9.xform = {1.0f, 0.0f, 0.0f, 1.0f, 160.0f, 0.0f};
    it9.draw_index = 7;
    it9.content_version = 1;
    it9.commands = {golden::add_texture_rect(true, 11, false, false, {0.0f, 0.0f, 16.0f, 16.0f})};
    s.items.push_back(it9);
    s.canvases[0] = golden::root_canvas({1, 2, 3, 4, 5, 8, 9});
  }
  if (n >= 8) {
    s.textures[6].variants = {block_variant(kHashDxt5x4, 122, "DXT5"), uastc_variant(kHashKtx4, 209)};
    s.textures[10].variants = {block_variant(kHashDxt5x16m, 476, "DXT5"),
                               uastc_variant(kHashKtx16, 593)};
    s.textures[5].version = 3;
    s.textures[5].hash = golden::kHashA1;
    s.textures[5].variants.clear();
    TextureEntry pending;
    pending.id = 12;
    pending.kind = TextureKind::Image;
    pending.status = TextureStatus::Unsupported;
    pending.has_reason = true;
    pending.reason = TextureReason::DeliveryPending;
    pending.version = 1;
    pending.width = 4;
    pending.height = 4;
    s.textures.push_back(pending);
  }
  return s;
}

Session session9(Encoding encoding, const std::string &stream_id, const std::string &session_id,
                 Delivery delivery) {
  Session session = golden::golden_session_v6(encoding, stream_id, session_id, delivery);
  session.version = ProtocolVersion::V9;
  session.resources.permitted_formats = {"L8",   "LA8",  "R8",   "RG8",   "RGB8", "RGBA8",
                                         "RF",   "RGF",  "RGBF", "RGBAF", "RH",   "RGH",
                                         "RGBH", "RGBAH"};
  session.resources.decode = TextureDecode::Engine;
  session.resources.texture_delivery.mode = "basis-uastc";
  session.resources.texture_delivery.has_encoder = true;
  session.resources.texture_delivery.encoder = "basisu-1.60";
  session.adoption.present = true;
  session.adoption.frame = 12;
  return session;
}


// --------------------------------------------------------------------------- /10's two states

CanvasGroupState group(CanvasGroupMode mode, float clear_margin = 5.0f, bool fit_empty = false,
                       float fit_margin = 0.0f, bool blur_mipmaps = false) {
  CanvasGroupState g;
  g.mode = mode;
  g.clear_margin = clear_margin;
  g.fit_empty = fit_empty;
  g.fit_margin = fit_margin;
  g.blur_mipmaps = blur_mipmaps;
  return g;
}

ItemState bb_item(std::uint32_t id, ParentRef parent, std::vector<std::uint32_t> children, float x,
                  std::int32_t draw_index, std::vector<Command> commands) {
  ItemState it;
  it.id = id;
  it.parent = parent;
  it.children = std::move(children);
  it.xform = {1.0f, 0.0f, 0.0f, 1.0f, x, 64.0f};
  it.draw_index = draw_index;
  it.content_version = 1;
  it.commands = std::move(commands);
  return it;
}

ItemState *find(Snapshot &s, std::uint32_t id) {
  for (ItemState &it : s.items) {
    if (it.id == id) {
      return &it;
    }
  }
  return nullptr;
}

// golden-9's eight states at /10 (n <= 8), then golden-10's states 9 and 10 (make_golden.py
// state9()/state10()).
Snapshot state10(int n) {
  Snapshot s = state9(n <= 8 ? n : 8);
  s.version = ProtocolVersion::V10;
  s.seq = static_cast<std::uint64_t>(n);
  s.frame = static_cast<std::uint64_t>(n);
  if (n <= 8) {
    return s;
  }
  ItemState owner = bb_item(10, ParentRef{ParentKind::Canvas, 1}, {11}, 0.0f, 8,
                            {golden::add_rect({0.0f, 0.0f, 32.0f, 32.0f}, {1.0f, 0.5f, 0.25f, 1.0f})});
  owner.canvas_group = group(CanvasGroupMode::ClipOnly);
  ItemState child = bb_item(11, ParentRef{ParentKind::Item, 10}, {}, 8.0f, 0,
                            {golden::add_rect({0.0f, 0.0f, 48.0f, 16.0f}, {0.25f, 0.5f, 1.0f, 1.0f})});
  child.canvas_group = group(CanvasGroupMode::ClipAndDraw);
  ItemState transparent = bb_item(12, ParentRef{ParentKind::Canvas, 1}, {}, 48.0f, 9, {});
  transparent.canvas_group = group(CanvasGroupMode::Transparent, 10.0f, true, 10.0f, true);
  ItemState rect_copy = bb_item(13, ParentRef{ParentKind::Canvas, 1}, {}, 96.0f, 10, {});
  rect_copy.copy_to_backbuffer = true;
  rect_copy.copy_to_backbuffer_rect = {-100.0f, -100.0f, 200.0f, 200.0f};
  ItemState full_copy = bb_item(14, ParentRef{ParentKind::Canvas, 1}, {}, 144.0f, 11,
                                {golden::add_rect({0.0f, 0.0f, 16.0f, 16.0f}, {0.5f, 1.0f, 0.5f, 1.0f})});
  full_copy.copy_to_backbuffer = true;
  full_copy.copy_to_backbuffer_rect = kZeroRect;
  s.items.push_back(owner);
  s.items.push_back(child);
  s.items.push_back(transparent);
  s.items.push_back(rect_copy);
  s.items.push_back(full_copy);
  s.canvases[0] = golden::root_canvas({1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 14});
  if (n >= 10) {
    find(s, 12)->canvas_group.fit_margin = 20.0f;
    ItemState *o = find(s, 10);
    o->canvas_group = CanvasGroupState();
    o->children.clear();
    ItemState *c = find(s, 13);
    c->copy_to_backbuffer = false;
    c->copy_to_backbuffer_rect = kZeroRect;
    ItemState *cleared = find(s, 14);
    cleared->content_version = 2;
    cleared->commands.clear();
    s.items.erase(std::remove_if(s.items.begin(), s.items.end(),
                                 [](const ItemState &it) { return it.id == 11; }),
                  s.items.end());
  }
  return s;
}

// golden-9's session at /10: both back-buffer hooks planned (the encoder sorts hooks_planned), so
// neither method is unobserved (render-stream-10.md "Features").
Session session10(Encoding encoding, const std::string &stream_id, const std::string &session_id,
                  Delivery delivery) {
  Session session = session9(encoding, stream_id, session_id, delivery);
  session.version = ProtocolVersion::V10;
  session.capture.hooks_planned.push_back("canvas_item_set_copy_to_backbuffer");
  session.capture.hooks_planned.push_back("canvas_item_set_canvas_group_mode");
  for (const char *name :
       {"canvas_item_set_canvas_group_mode", "canvas_item_set_copy_to_backbuffer"}) {
    auto &list = session.features.unobserved;
    const auto it = std::find(list.begin(), list.end(), name);
    check(it != list.end(), "golden-9's session declares both setters unobserved");
    if (it != list.end()) {
      list.erase(it);
    }
  }
  return session;
}

// --------------------------------------------------------------------------- /11's six states

// make_golden.py body_of(): a render-stream-mesh/1 payload without its 12-byte header (magic, meta
// length) and its meta.
std::vector<std::uint8_t> body_of(const std::vector<std::uint8_t> &payload) {
  if (payload.size() < 12) {
    return {};
  }
  const std::size_t meta_len = static_cast<std::size_t>(payload[8]) |
                               (static_cast<std::size_t>(payload[9]) << 8) |
                               (static_cast<std::size_t>(payload[10]) << 16) |
                               (static_cast<std::size_t>(payload[11]) << 24);
  if (12 + meta_len > payload.size()) {
    return {};
  }
  return std::vector<std::uint8_t>(payload.begin() + static_cast<long>(12 + meta_len),
                                   payload.end());
}

std::shared_ptr<const std::vector<std::uint8_t>> load_body(const std::string &path, bool grm) {
  const std::vector<std::uint8_t> bytes = read_file(path);
  check(!bytes.empty(), (path + " is readable").c_str());
  return std::make_shared<const std::vector<std::uint8_t>>(grm ? body_of(bytes) : bytes);
}

struct Bodies {
  std::shared_ptr<const std::vector<std::uint8_t>> mesh1_dyn, mesh1_tri, mesh2_tri, mesh2_v1,
      mesh2_v2;
};

const Bodies &bodies() {
  static const Bodies b = [] {
    Bodies out;
    const std::string g11 = std::string(GRC_GOLDEN11_DIR) + "/payloads/";
    const std::string g6 = std::string(GRC_GOLDEN6_DIR) + "/payloads/";
    out.mesh1_dyn = load_body(g11 + "mesh1-dyn.body", false);
    out.mesh1_tri = load_body(g11 + "mesh1-tri.body", false);
    out.mesh2_tri = load_body(g11 + "mesh2-tri.body", false);
    out.mesh2_v1 = load_body(g6 + "mesh2-v1.grm", true);
    out.mesh2_v2 = load_body(g6 + "mesh2-v2.grm", true);
    return out;
  }();
  return b;
}

// make_golden.py dynamic_surface(): no hash, payload_bytes the body's length.
MeshSurface dynamic_surface(const std::shared_ptr<const std::vector<std::uint8_t>> &body,
                            std::int64_t format, std::int32_t vertex_count,
                            std::int32_t index_count) {
  MeshSurface s = golden::mesh_surface("", body->size(), Primitive::Triangles, format, vertex_count,
                                       index_count);
  s.body = body;
  return s;
}

constexpr std::int64_t kMesh1TriFormat = golden::kArrayFormatTexUv | golden::kArrayFlagUse2dVertices;

MeshEntry *find_mesh(Snapshot &s, std::uint32_t id) {
  for (MeshEntry &m : s.meshes) {
    if (m.id == id) {
      return &m;
    }
  }
  return nullptr;
}

TextureEntry *find_texture(Snapshot &s, std::uint32_t id) {
  for (TextureEntry &t : s.textures) {
    if (t.id == id) {
      return &t;
    }
  }
  return nullptr;
}

// --------------------------------------------------------------------------- PM1's five states

// make_golden.py mm1_buffer(s, n): colors and custom, stride 16.
std::shared_ptr<const std::vector<float>> mm1_buffer(int s, int n) {
  auto out = std::make_shared<std::vector<float>>();
  for (int i = 0; i < n; ++i) {
    const float fi = static_cast<float>(i);
    const float fs = static_cast<float>(s);
    for (float v : {1.0f, 0.0f, 0.0f, 10.0f * fi + fs, 0.0f, 1.0f, 0.0f, 5.0f * fi + 0.5f,
                    0.25f * (fi + 1.0f), 0.5f, 0.75f, 1.0f, fs, fi, 0.5f, 0.125f}) {
      out->push_back(v);
    }
  }
  return out;
}

// make_golden.py mm2_buffer(s, n): transforms only, stride 8.
std::shared_ptr<const std::vector<float>> mm2_buffer(int s, int n) {
  auto out = std::make_shared<std::vector<float>>();
  for (int i = 0; i < n; ++i) {
    const float fi = static_cast<float>(i);
    for (float v : {2.0f, 0.0f, 0.0f, 32.0f + 16.0f * fi, 0.0f, 2.0f, 0.0f,
                    static_cast<float>(s) + 0.5f * fi}) {
      out->push_back(v);
    }
  }
  return out;
}

Command add_multimesh(std::uint32_t id, bool has_tex = false, std::uint32_t tex = 0) {
  Command c;
  c.kind = CommandKind::AddMultimesh;
  c.multimesh = id;
  c.has_tex = has_tex;
  c.tex = tex;
  return c;
}

MultimeshEntry multimesh(std::uint32_t id, std::uint64_t version, std::int32_t instances,
                         bool colors, bool custom,
                         std::shared_ptr<const std::vector<float>> buffer, std::uint64_t serial) {
  MultimeshEntry m;
  m.id = id;
  m.version = version;
  m.instances = instances;
  m.colors = colors;
  m.custom = custom;
  m.buffer = std::move(buffer);
  m.buffer_serial = serial;
  return m;
}

MultimeshEntry *find_mm(Snapshot &s, std::uint32_t id) {
  for (MultimeshEntry &m : s.multimeshes) {
    if (m.id == id) {
      return &m;
    }
  }
  return nullptr;
}

UnsupportedRef mm_ref(std::uint32_t item, UnsupportedReason reason) {
  UnsupportedRef u;
  u.op = "canvas_item_add_multimesh";
  u.has_item = true;
  u.item = item;
  u.reason = reason;
  return u;
}

// make_golden.py state17() ... state21() on top of state 16. Buffer serials move exactly where
// make_golden.py's buffers change (multimesh 1 at 18 and 19; multimesh 2 never).
void add_multimesh_states(Snapshot *state, int n) {
  Snapshot &s = *state;
  s.multimesh_commands = true;
  MultimeshEntry mm1 = multimesh(1, 4, 3, true, true, mm1_buffer(17, 3), 1);
  mm1.has_mesh = true;
  mm1.mesh = 1;
  MultimeshEntry mm2 = multimesh(2, 5, 2, false, false, mm2_buffer(17, 2), 1);
  mm2.visible = 1;
  mm2.custom_aabb = {-4.0f, -4.0f, 0.0f, 72.0f, 40.0f, 0.0f};
  MultimeshEntry mm3 = multimesh(3, 2, 4, false, false, nullptr, 0);
  mm3.status = MultimeshStatus::Unsupported;
  mm3.has_reason = true;
  mm3.reason = MultimeshReason::Multimesh3d;
  mm3.format = MultimeshFormat::ThreeD;
  s.multimeshes = {mm1, mm2, mm3};
  s.items.push_back(bb_item(16, ParentRef{ParentKind::Canvas, 1}, {}, 192.0f, 12,
                            {add_multimesh(1, true, 1), add_multimesh(2), add_multimesh(3)}));
  s.items.push_back(bb_item(17, ParentRef{ParentKind::Canvas, 1}, {}, 208.0f, 13,
                            {golden::unsupported_cmd("canvas_item_add_multimesh",
                                                     UnsupportedCmdReason::UnknownMultimesh)}));
  s.canvases[0] = golden::root_canvas({1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 14, 16, 17});
  s.unsupported.push_back(mm_ref(16, UnsupportedReason::UnsupportedMultimesh));
  s.unsupported.push_back(mm_ref(17, UnsupportedReason::UnknownMultimesh));
  if (n >= 18) {
    // 18: multimesh 1's buffer moves; multimesh 2's custom AABB moves over equal floats.
    MultimeshEntry *m1 = find_mm(s, 1);
    m1->version = 5;
    m1->buffer = mm1_buffer(18, 3);
    m1->buffer_serial = 2;
    MultimeshEntry *m2 = find_mm(s, 2);
    m2->version = 6;
    m2->custom_aabb = {-8.0f, -8.0f, 0.0f, 80.0f, 48.0f, 0.0f};
  }
  if (n >= 19) {
    // 19: multimesh 1 re-allocated to five instances; multimesh 3 freed (a tombstone, still named).
    MultimeshEntry *m1 = find_mm(s, 1);
    m1->version = 7;
    m1->instances = 5;
    m1->buffer = mm1_buffer(19, 5);
    m1->buffer_serial = 3;
    MultimeshEntry freed;
    freed.id = 3;
    freed.status = MultimeshStatus::Freed;
    freed.version = 3;
    *find_mm(s, 3) = freed;
    s.unsupported.erase(s.unsupported.end() - 2);  // item 16's unsupported-multimesh entry
  }
  if (n >= 20) {
    // 20 (and 21, unchanged): item 16 draws multimesh 1 only; multimeshes 2 and 3 leave.
    s.multimeshes.erase(s.multimeshes.begin() + 1, s.multimeshes.end());
    ItemState *it = find(s, 16);
    it->content_version = 2;
    it->commands = {add_multimesh(1, true, 1)};
  }
}

// golden-10's ten states at /11 (n <= 10), then golden-11's states 11 to 21 (make_golden.py
// state11() ... state21()). Content serials move exactly where make_golden.py's bodies change.
Snapshot state11(int n) {
  Snapshot s = state10(n <= 10 ? n : 10);
  s.version = ProtocolVersion::V11;
  s.seq = static_cast<std::uint64_t>(n);
  s.frame = static_cast<std::uint64_t>(n);
  if (n <= 10) {
    return s;
  }
  const Bodies &b = bodies();
  const Snapshot ten = state10(10);
  // 11: mesh 1 turns dynamic with new bytes; mesh 2 is new, dynamic, two surfaces; item 15 draws it.
  MeshEntry *m1 = find_mesh(s, 1);
  m1->version = 3;
  m1->surfaces = {dynamic_surface(b.mesh1_dyn, golden::kMesh1SurfaceBFormat, 4, 6)};
  m1->dynamic = true;
  m1->content_serial = 1;
  MeshEntry m2 = golden::mesh_entry(
      MeshStatus::Ok, 1,
      {dynamic_surface(b.mesh2_v1, golden::kMesh2SurfaceFormat, 4, 6),
       dynamic_surface(b.mesh2_tri, golden::kMesh1SurfaceAFormat, 3, 0)});
  m2.id = 2;
  m2.dynamic = true;
  m2.content_serial = 1;
  s.meshes.push_back(m2);
  s.items.push_back(bb_item(15, ParentRef{ParentKind::Canvas, 1}, {}, 192.0f, 12,
                            {golden::add_mesh(2, kIdentityXform)}));
  s.canvases[0] = golden::root_canvas({1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 14, 15});
  if (n >= 12) {
    // 12: mesh 1's custom AABB changes with equal bytes; texture 5's hash F leaves.
    m1 = find_mesh(s, 1);
    m1->version = 4;
    m1->custom_aabb = {0.0f, 0.0f, 0.0f, 32.0f, 32.0f, 0.0f};
    TextureEntry *t5 = find_texture(s, 5);
    t5->version = 2;
    t5->hash = golden::kHashA2;
    t5->format = "RGBA8";
    t5->width = 16;
    t5->height = 16;
    t5->payload_bytes = 1135;
  }
  if (n >= 13) {
    // 13: F returns; mesh 2's first surface gets new bytes of the same shape.
    Snapshot ten_copy = ten;
    TextureEntry t5 = *find_texture(ten_copy, 5);
    t5.version = 3;
    *find_texture(s, 5) = t5;
    MeshEntry *mesh2 = find_mesh(s, 2);
    mesh2->version = 2;
    mesh2->surfaces = {dynamic_surface(b.mesh2_v2, golden::kMesh2SurfaceFormat, 4, 6),
                       dynamic_surface(b.mesh2_tri, golden::kMesh1SurfaceAFormat, 3, 0)};
    mesh2->content_serial = 2;
  }
  if (n >= 14) {
    // 14: mesh 1's shape changes; item 15 draws the unsupported texture 3 too.
    m1 = find_mesh(s, 1);
    m1->version = 5;
    m1->surfaces = {dynamic_surface(b.mesh1_tri, kMesh1TriFormat, 3, 0)};
    m1->content_serial = 2;
    ItemState *it = find(s, 15);
    it->content_version = 2;
    it->commands = {golden::add_mesh(2, kIdentityXform),
                    golden::add_texture_rect(true, 3, false, false, {0.0f, 0.0f, 4.0f, 4.0f})};
    UnsupportedRef u;
    u.op = "canvas_item_add_texture_rect";
    u.has_item = true;
    u.item = 15;
    u.reason = UnsupportedReason::UnsupportedTexture;
    s.unsupported.push_back(u);
  }
  if (n >= 15) {
    // 15 (and 16, unchanged): mesh 2 freed, item 15 removed, golden-10's unsupported list back.
    MeshEntry freed = golden::mesh_entry(MeshStatus::Freed, 3);
    freed.id = 2;
    *find_mesh(s, 2) = freed;
    s.items.erase(std::remove_if(s.items.begin(), s.items.end(),
                                 [](const ItemState &it) { return it.id == 15; }),
                  s.items.end());
    s.canvases[0] = golden::root_canvas({1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 14});
    s.unsupported = ten.unsupported;
  }
  if (n >= 17) {
    add_multimesh_states(&s, n);
  }
  if (n >= 22) {
    // UIT (make_golden.py state22()/state23()): item 18, a child of item 16, with
    // use_identity_transform true; at 23 it turns false (the key absent), nothing else.
    find(s, 16)->children = {18};
    ItemState it = bb_item(18, ParentRef{ParentKind::Item, 16}, {}, 8.0f, 0,
                           {golden::add_rect({0.0f, 0.0f, 8.0f, 8.0f}, {1.0f, 0.25f, 0.5f, 1.0f})});
    it.use_identity_transform = n == 22;
    s.items.push_back(it);
  }
  return s;
}

// golden-10's session at /11: resources.mesh_dynamic {"auto", 4, 65536} (the defaults).
Session session11(Encoding encoding, const std::string &stream_id, const std::string &session_id,
                  Delivery delivery) {
  Session session = session10(encoding, stream_id, session_id, delivery);
  session.version = ProtocolVersion::V11;
  observe_multimesh_features(&session.features);  // PM1 rule 8
  return session;
}

// --------------------------------------------------------------------------- golden matches

void test_matches_golden_full_rs11() {
  const Session session = session11(Encoding::Full, golden::kFullStreamId, golden::kFullSessionId,
                                    Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V11));
  records.push_back(encode_session(session));
  for (int n = 1; n <= kStates; ++n) {
    records.push_back(encode_transaction(make_full(state11(n))));
  }
  End end = make_end(kStates, 0, 0, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("full.rs11", all);
}

// Through make_patch(): seq 1, 5, 16 and 21 full, every other seq a patch against its predecessor.
void test_matches_golden_patch_rs11() {
  const Session session = session11(Encoding::Patch, golden::kPatchStreamId,
                                    golden::kPatchSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V11));
  records.push_back(encode_session(session));
  for (int n = 1; n <= kStates; ++n) {
    if (n == 1 || n == 5 || n == 16 || n == 21) {
      records.push_back(encode_transaction(make_full(state11(n))));
    } else {
      records.push_back(encode_transaction(make_patch(state11(n - 1), state11(n))));
    }
  }
  End end = make_end(4, kStates - 4, 12345, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("patch.rs11", all);
}

// golden-10/payloads/ by hash: every inline payload golden-11 names.
const std::map<std::string, std::string> &payload_files() {
  static const std::map<std::string, std::string> files = {
      {golden::kHashA1, "a1.grt"},
      {golden::kHashA2, "a2.grt"},
      {golden::kHashF, "f.grt"},
      {kHashDec, "dec.grt"},
      {kHashRgbaf, "rgbaf.grt"},
      {kHashRh, "rh.grt"},
      {kHashMesh1A, "mesh1-a.grm"},
      {kHashMesh1B, "mesh1-b.grm"},
      {kHashShader, "shader2-tint-v1.grp"},
      {kHashMip16, "mip16.grt"},
      {kHashDxt5x16m, "dxt5-16x16-mips.grt"},
      {kHashDxt5x4, "dxt5-4x4.grt"},
      {kHashKtx16, "ktx2-16x16-mips.ktx2"},
      {kHashKtx4, "ktx2-4x4.ktx2"},
  };
  return files;
}

// make_golden.py inline_recording(): the sixteen states as full transactions with inline delivery,
// each preceded by exactly the records the planner returns for (previous state, state).
std::vector<std::vector<std::uint8_t>> inline_recording(bool keep_carried) {
  const Session session = session11(Encoding::Full, std::string(32, '3'), std::string(32, '3'),
                                    Delivery::Inline);
  InlinePolicy policy;
  policy.inline_max_bytes = session.resources.inline_max_bytes;
  policy.inline_variants = true;  // golden-11 carries every variant inline
  RecordPlanner planner(ProtocolVersion::V11, policy, keep_carried);
  const std::string dir = std::string(GRC_GOLDEN10_DIR) + "/payloads/";
  std::uint64_t resource_bytes = 0;
  std::uint64_t resource_count = 0;
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V11));
  records.push_back(encode_session(session));
  std::optional<Snapshot> prev;
  for (int n = 1; n <= kStates; ++n) {
    const Snapshot cur = state11(n);
    for (const PayloadName &name : planner.next(prev ? &*prev : nullptr, cur)) {
      const auto file = payload_files().find(name.hash);
      check(file != payload_files().end(), ("a payload file for " + name.hash).c_str());
      if (file == payload_files().end()) {
        continue;
      }
      const std::vector<std::uint8_t> payload = read_file(dir + file->second);
      check(payload.size() == name.payload_bytes,
            (file->second + "'s length is the state's payload_bytes").c_str());
      resource_bytes += payload.size();
      ++resource_count;
      records.push_back(encode_resource(ResourceRecord{name.hash, payload}));
    }
    records.push_back(encode_transaction(make_full(cur)));
    prev = cur;
  }
  End end = make_end(kStates, 0, 0, resource_count, resource_bytes, records);
  records.push_back(encode_end(end));
  return records;
}

void test_matches_golden_inline_rs11() {
  check_against_golden("inline.rs11", inline_recording(false));
}

// As built rule 10: keep-carried keeps /10's lifelong set at /11, so F's record before seq 13 is
// never written. Its output is exactly invalid/resource-missing.rs11.
void test_keep_carried_is_resource_missing() {
  check_against_golden("invalid/resource-missing.rs11", inline_recording(true));
}

// --------------------------------------------------------------------------- semantics

std::string text_of(const std::vector<std::uint8_t> &bytes) {
  return std::string(bytes.begin(), bytes.end());
}

const MeshEntry *patch_mesh(const Transaction &t, std::uint32_t id) {
  for (const MeshEntry &m : t.meshes) {
    if (m.id == id) {
      return &m;
    }
  }
  return nullptr;
}

bool held(const Transaction &t, std::uint32_t id) {
  return std::find(t.mesh_bodies_held.begin(), t.mesh_bodies_held.end(), id) !=
         t.mesh_bodies_held.end();
}

// make_patch()'s u8 rule over the golden states: the transition (11), equal bytes (12), a serial
// change (13), a shape change (14), a freed entry (15); and `unsupported_as_base`.
void test_patch_u8_rule() {
  const Transaction p11 = make_patch(state11(10), state11(11));
  check(patch_mesh(p11, 1) != nullptr && !held(p11, 1), "11: static to dynamic sends the bodies");
  check(patch_mesh(p11, 2) != nullptr && !held(p11, 2), "11: a new dynamic entry sends its bodies");
  const std::string t11 = text_of(encode_transaction(p11));
  check(t11.find("\"f\":0,\"u8\":0,\"surfaces\":[{\"hash\":null,\"payload_bytes\":116,") !=
            std::string::npos,
        "11: mesh 1 at u8 0 with a null hash and its body length");
  check(t11.find("\"u8\":116,\"surfaces\":[{\"hash\":null,") != std::string::npos,
        "11: mesh 2's bodies follow mesh 1's");
  check(t11.find("{\"name\":\"mesh_u8\",\"type\":\"u8\",\"count\":") != std::string::npos &&
            t11.find("{\"name\":\"mm_f32\",\"type\":\"f32\",\"count\":0}]") != std::string::npos,
        "11: mesh_u8 then an empty mm_f32 close the blocks");
  check(t11.find("\"unsupported\":null") != std::string::npos && p11.unsupported_as_base,
        "11: an unchanged unsupported list is null in a patch");
  const Transaction p12 = make_patch(state11(11), state11(12));
  check(patch_mesh(p12, 1) != nullptr && held(p12, 1), "12: an AABB change alone holds the bodies");
  check(text_of(encode_transaction(p12)).find("\"u8\":null,\"surfaces\":[{\"hash\":null,") !=
            std::string::npos,
        "12: u8 null on a dynamic entry");
  const Transaction p13 = make_patch(state11(12), state11(13));
  check(patch_mesh(p13, 1) == nullptr, "13: mesh 1 unchanged is not in the patch");
  check(patch_mesh(p13, 2) != nullptr && !held(p13, 2), "13: a serial change sends the bodies");
  Snapshot same_serial = state11(13);
  find_mesh(same_serial, 2)->content_serial = 1;
  Snapshot base12 = state11(12);
  const Transaction p13s = make_patch(base12, same_serial);
  check(patch_mesh(p13s, 2) != nullptr && held(p13s, 2),
        "a version move with the base's serial holds the bodies (the serial decides, not bytes)");
  find_mesh(same_serial, 2)->version = 1;
  check(patch_mesh(make_patch(base12, same_serial), 2) == nullptr,
        "an equal entry with an equal serial is not in the patch");
  Snapshot bumped = state11(12);
  bumped.seq = 13;
  find_mesh(bumped, 2)->content_serial = 7;
  check(patch_mesh(make_patch(base12, bumped), 2) != nullptr,
        "a serial change alone puts the entry in the patch");
  const Transaction p14 = make_patch(state11(13), state11(14));
  check(patch_mesh(p14, 1) != nullptr && !held(p14, 1), "14: a shape change sends the bodies");
  check(!p14.unsupported_as_base && text_of(encode_transaction(p14)).find("\"unsupported\":[") !=
                                       std::string::npos,
        "14: a changed unsupported list is complete");
  const Transaction p15 = make_patch(state11(14), state11(15));
  const MeshEntry *freed = patch_mesh(p15, 2);
  check(freed != nullptr && !held(p15, 2), "15: a freed entry is in the patch, nothing held");
  check(text_of(encode_transaction(p15)).find("\"f\":null,\"u8\":null,\"surfaces\":[]") !=
            std::string::npos,
        "15: a freed entry writes u8 null");
  check(make_full(state11(16)).mesh_bodies_held.empty() &&
            text_of(encode_transaction(make_full(state11(12)))).find("\"u8\":null,\"surfaces\":[{"
                                                                     "\"hash\":null") ==
                std::string::npos,
        "a full never holds a dynamic mesh's bodies");
  check(text_of(encode_transaction(make_full(state11(4)))).find("\"u8\":null,\"surfaces\":[{"
                                                                "\"hash\":\"") != std::string::npos,
        "a static mesh writes u8 null and its hash");
}

// Records from (B, T): inline(T) \ inline(B) in table order, and RecordPlanner's two modes.
void test_records_from_base_and_target() {
  InlinePolicy policy;
  policy.inline_max_bytes = 16777216;
  policy.inline_variants = true;
  const Snapshot s11 = state11(11);
  const Snapshot s12 = state11(12);
  const Snapshot s13 = state11(13);
  for (const PayloadName &n : payload_names(s11)) {
    check(n.hash != kHashMesh1B, "a dynamic mesh names no hash");
  }
  const std::vector<PayloadName> r13 = records_before(&s12, s13, policy);
  check(r13.size() == 1 && r13[0].hash == golden::kHashF, "13: F returns and is re-carried");
  check(records_before(&s13, s13, policy).empty(), "a repeated target carries nothing");
  check(records_before(&s11, s12, policy).empty(), "12: A2 is still named, nothing to carry");
  const std::vector<PayloadName> first = records_before(nullptr, s13, policy);
  const std::vector<PayloadName> all = inline_names(s13, policy);
  check(first.size() == all.size(), "a stream's first transaction carries inline(T)");
  InlinePolicy small = policy;
  small.inline_max_bytes = 200;
  for (const PayloadName &n : records_before(nullptr, s13, small)) {
    check(n.payload_bytes <= 200, "the inline decision is the payload size alone");
  }
  InlinePolicy no_variants = policy;
  no_variants.inline_variants = false;
  for (const PayloadName &n : inline_names(state11(8), no_variants)) {
    check(n.hash != kHashDxt5x4 && n.hash != kHashKtx4, "variants stay out of inline(S) by default");
  }
  RecordPlanner lifelong(ProtocolVersion::V11, policy, true);
  RecordPlanner by_base(ProtocolVersion::V11, policy, false);
  check(lifelong.lifelong() && !by_base.lifelong() &&
            RecordPlanner(ProtocolVersion::V10, policy).lifelong(),
        "keep-carried and every version below /11 keep the lifelong set");
}

void test_magic_and_protocol() {
  const std::vector<std::uint8_t> m = magic(ProtocolVersion::V11);
  check(m.size() == 8 && m[0] == 'G' && m[1] == 'R' && m[2] == 'S' && m[3] == 'B' &&
            m[4] == 0x0D && m[5] == 0x0A && m[6] == 0x1A && m[7] == 0x0A,
        "magic(V11) is GRSB\\r\\n\\x1a\\n");
  check(std::string(kProtocolV11) == "render-stream/11", "kProtocolV11 is render-stream/11");
  check(is_v7_or_later(ProtocolVersion::V11) && is_v8_or_later(ProtocolVersion::V11) &&
            is_v9_or_later(ProtocolVersion::V11) && is_v10_or_later(ProtocolVersion::V11) &&
            is_v10_or_later(ProtocolVersion::V10) && !is_v10_or_later(ProtocolVersion::V9),
        "V11 is V7 to V10 or later");
  Session session = session11(Encoding::Full, std::string(32, '1'), std::string(32, 'a'),
                              Delivery::OutOfBand);
  check(text_of(encode_session(session))
                .find("\"texture_delivery\":{\"mode\":\"basis-uastc\",\"encoder\":\"basisu-1.60\"},"
                      "\"mesh_dynamic\":{\"mode\":\"auto\",\"frames\":4,\"max_bytes\":65536}}") !=
            std::string::npos,
        "mesh_dynamic is the last resources key, defaults auto/4/65536");
  session.resources.mesh_dynamic.mode = MeshDynamicMode::Off;
  session.resources.mesh_dynamic.frames = 9;
  session.resources.mesh_dynamic.max_bytes = 0;
  check(text_of(encode_session(session))
                .find("\"mesh_dynamic\":{\"mode\":\"off\",\"frames\":9,\"max_bytes\":0}") !=
            std::string::npos,
        "mesh_dynamic carries the policy");
  check(std::string(to_wire(MeshDynamicMode::All)) == "all", "mode all");
  Session s10 = session;
  s10.version = ProtocolVersion::V10;
  check(text_of(encode_session(s10)).find("mesh_dynamic") == std::string::npos,
        "a /10 session has no mesh_dynamic");
}

// Below /11 the dynamic fields never reach the wire: a /10 encode of a state with a dynamic mesh
// equals the same state with the flags cleared, and a /10 patch neither nulls unsupported nor
// carries an entry for a serial change alone.
void test_fields_ignored_at_v10() {
  Snapshot with = state11(11);
  with.version = ProtocolVersion::V10;
  for (MeshEntry &mesh : with.meshes) {
    for (MeshSurface &s : mesh.surfaces) {
      s.hash = std::string(64, 'c');
    }
  }
  Snapshot without = with;
  for (MeshEntry &mesh : without.meshes) {
    mesh.dynamic = false;
    mesh.content_serial = 0;
    for (MeshSurface &s : mesh.surfaces) {
      s.body.reset();
    }
  }
  check(encode_transaction(make_full(with)) == encode_transaction(make_full(without)),
        "a /10 transaction ignores the dynamic fields");
  Snapshot cur = with;
  cur.seq = 12;
  find_mesh(cur, 2)->content_serial = 9;
  const Transaction p10 = make_patch(with, cur);
  check(p10.meshes.empty() && !p10.unsupported_as_base && p10.mesh_bodies_held.empty(),
        "a /10 patch: no entry for a serial change, unsupported never as-base");
  check(text_of(encode_transaction(p10)).find("\"unsupported\":[") != std::string::npos,
        "a /10 patch carries the complete unsupported list");
}

// PM1 rules 3, 9 and 11: make_patch's multimesh membership and buffer_f (from the serials), the
// removed list, the perturb-instance flag, and the lowering below /11 (rule 7).
void test_multimesh_patch_rules() {
  const auto mm_of = [](const Transaction &t, std::uint32_t id) -> const MultimeshEntry * {
    for (const MultimeshEntry &m : t.multimeshes) {
      if (m.id == id) {
        return &m;
      }
    }
    return nullptr;
  };
  const auto held_in = [](const Transaction &t, std::uint32_t id) {
    return std::binary_search(t.multimesh_buffers_held.begin(), t.multimesh_buffers_held.end(),
                              id);
  };
  const Transaction p18 = make_patch(state11(17), state11(18));
  check(mm_of(p18, 1) != nullptr && !held_in(p18, 1), "18: a serial change writes the buffer");
  check(mm_of(p18, 2) != nullptr && held_in(p18, 2), "18: an AABB change alone holds the floats");
  check(mm_of(p18, 3) == nullptr, "18: an unchanged entry is not in the patch");
  Snapshot same = state11(18);
  find_mm(same, 1)->buffer_serial = 1;  // the base's serial: the floats are the ones it holds
  const Transaction p18s = make_patch(state11(17), same);
  check(mm_of(p18s, 1) != nullptr && held_in(p18s, 1),
        "an equal serial holds the floats (the version still moved)");
  const Transaction p19 = make_patch(state11(18), state11(19));
  check(mm_of(p19, 1) != nullptr && !held_in(p19, 1), "19: a re-allocate writes the buffer");
  check(mm_of(p19, 3) != nullptr && mm_of(p19, 3)->status == MultimeshStatus::Freed,
        "19: the tombstone is in the patch");
  const Transaction p20 = make_patch(state11(19), state11(20));
  check(p20.multimeshes.empty() && p20.removed_multimeshes == std::vector<std::uint32_t>({2, 3}),
        "20: removed_multimeshes [2, 3], no entry");
  const std::string t20 = text_of(encode_transaction(p20));
  check(t20.find("\"removed_multimeshes\":[2,3]") != std::string::npos &&
            t20.find("\"multimeshes\"") == std::string::npos,
        "20: the key `multimeshes` is absent, removed_multimeshes present (rule 1)");
  check(make_patch(state11(20), state11(21)).multimeshes.empty(),
        "a repeated target carries no multimesh entry");
  // perturb-instance: +1.0 on the first buffer float (multimesh 1's, mm_f32 float 6).
  Transaction full17 = make_full(state11(17));
  const std::vector<std::uint8_t> plain = encode_transaction(full17);
  full17.perturb_instance = true;
  const std::vector<std::uint8_t> perturbed = encode_transaction(full17);
  std::size_t differing = 0;
  for (std::size_t i = 0; i < plain.size() && i < perturbed.size(); ++i) {
    differing += plain[i] != perturbed[i] ? 1 : 0;
  }
  const float first = (*mm1_buffer(17, 3))[0] + 1.0f;
  std::uint8_t want[4];
  std::memcpy(want, &first, 4);
  const std::size_t at = plain.size() - 4 * (82 - 6);  // mm_f32 is the last block (82 floats)
  check(plain.size() == perturbed.size() && differing > 0 && differing <= 4 &&
            std::memcmp(perturbed.data() + at, want, 4) == 0,
        "perturb-instance adds 1.0 to the first buffer float it writes, nothing else");
  // Below /11: no table, the commands and entries as before PM1.
  Snapshot v10 = state11(17);
  v10.version = ProtocolVersion::V10;
  const std::string t10 = text_of(encode_transaction(make_full(v10)));
  check(t10.find("multimesh\":") == std::string::npos &&
            t10.find("\"add_multimesh\"") == std::string::npos &&
            t10.find("{\"op\":\"canvas_item_add_multimesh\",\"item\":16,\"reason\":\"unsupported-op\"},"
                     "{\"op\":\"canvas_item_add_multimesh\",\"item\":17,\"reason\":\"unsupported-op\"}") !=
                std::string::npos,
        "a /10 transaction lowers add_multimesh and its entries to unsupported-op");
}

}  // namespace

int main() {
  test_multimesh_patch_rules();
  test_magic_and_protocol();
  test_matches_golden_full_rs11();
  test_matches_golden_patch_rs11();
  test_matches_golden_inline_rs11();
  test_keep_carried_is_resource_missing();
  test_patch_u8_rule();
  test_records_from_base_and_target();
  test_fields_ignored_at_v10();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs11_codec_test: all checks passed\n");
  return 0;
}
