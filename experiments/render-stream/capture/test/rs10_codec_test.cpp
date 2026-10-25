// Unit tests for render-stream/10 (src/rs2_codec.cpp's and rs2_diff.cpp's version == V10 path,
// CG1).
//
// render-stream/10 is a protocol-version switch inside the SAME rs2_codec/rs2_diff modules /2-/9 use
// (render-stream-10.md), so this file proves only /10's delta: the GRSA magic and the
// "render-stream/10" protocol string, the item keys `canvas_group` and `copy_to_backbuffer` with
// their running offsets into the seventh block `backbuffer_f32`, and the diff engine carrying an
// item whose back-buffer state alone changed (with `commands: null`) -- by matching
// protocol/golden-10/{full,patch,inline}.rs10 byte for byte. It also proves that both keys are
// ignored at /9 (a V9 transaction built from back-buffer-carrying structs is byte-equal to the
// same transaction without them, and a /9 patch carries no entry for a back-buffer change alone),
// so /2-/9 output is unchanged.
//
// The ten states mirror protocol/golden-10/make_golden.py: golden-9's eight states (state9()
// below, copied from rs9_codec_test.cpp) plus two /10 states built here (state10()).

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <optional>
#include <cstdio>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"

#ifndef GRC_GOLDEN10_DIR
#error "GRC_GOLDEN10_DIR must be defined by CMakeLists.txt"
#endif

namespace {

using namespace grc::rs2;  // NOLINT

int g_failures = 0;

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
  const std::vector<std::uint8_t> expected = read_file(std::string(GRC_GOLDEN10_DIR) + "/" + file);
  check(!expected.empty(), ("golden-10/" + file + " is readable").c_str());
  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-10/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(),
        ("encoded recording is exactly golden-10/" + file + "'s length").c_str());
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

void test_matches_golden_full_rs10() {
  const Session session = session10(Encoding::Full, golden::kFullStreamId, golden::kFullSessionId,
                                    Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V10));
  records.push_back(encode_session(session));
  for (int n = 1; n <= 10; ++n) {
    records.push_back(encode_transaction(make_full(state10(n))));
  }
  End end = make_end(10, 0, 0, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("full.rs10", all);
}

// Through make_patch(): seq 2-4 patch against their predecessor, seq 5 is a full resync, seq 6-10
// patches -- seq 10 carries item 12 (a block float changed, commands null), 10, 13 and 14.
void test_matches_golden_patch_rs10() {
  const Session session = session10(Encoding::Patch, golden::kPatchStreamId,
                                    golden::kPatchSessionId, Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V10));
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(make_full(state10(1))));
  for (int n = 2; n <= 4; ++n) {
    records.push_back(encode_transaction(make_patch(state10(n - 1), state10(n))));
  }
  records.push_back(encode_transaction(make_full(state10(5))));
  for (int n = 6; n <= 10; ++n) {
    records.push_back(encode_transaction(make_patch(state10(n - 1), state10(n))));
  }
  End end = make_end(2, 8, 12345, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("patch.rs10", all);
}

void test_matches_golden_inline_rs10() {
  const Session session = session10(Encoding::Full, std::string(32, '3'),
                                    "22222222222222222222222222222222", Delivery::Inline);
  const std::string dir = std::string(GRC_GOLDEN10_DIR) + "/payloads/";
  std::uint64_t resource_bytes = 0;
  std::uint64_t resource_count = 0;
  const auto resource = [&](const std::string &hash, const std::string &file) {
    const std::vector<std::uint8_t> payload = read_file(dir + file);
    check(!payload.empty(), (file + " is readable").c_str());
    resource_bytes += payload.size();
    ++resource_count;
    return encode_resource(ResourceRecord{hash, payload});
  };
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V10));
  records.push_back(encode_session(session));
  records.push_back(resource(golden::kHashA1, "a1.grt"));
  records.push_back(resource(golden::kHashF, "f.grt"));
  records.push_back(encode_transaction(make_full(state10(1))));
  records.push_back(encode_transaction(make_full(state10(2))));
  records.push_back(resource(golden::kHashA2, "a2.grt"));
  records.push_back(encode_transaction(make_full(state10(3))));
  records.push_back(resource(kHashDec, "dec.grt"));
  records.push_back(resource(kHashRgbaf, "rgbaf.grt"));
  records.push_back(resource(kHashRh, "rh.grt"));
  records.push_back(resource(kHashMesh1A, "mesh1-a.grm"));
  records.push_back(resource(kHashShader, "shader2-tint-v1.grp"));
  records.push_back(encode_transaction(make_full(state10(4))));
  records.push_back(resource(kHashMesh1B, "mesh1-b.grm"));
  records.push_back(encode_transaction(make_full(state10(5))));
  records.push_back(encode_transaction(make_full(state10(6))));
  records.push_back(resource(kHashMip16, "mip16.grt"));
  records.push_back(resource(kHashDxt5x16m, "dxt5-16x16-mips.grt"));
  records.push_back(resource(kHashDxt5x4, "dxt5-4x4.grt"));
  records.push_back(encode_transaction(make_full(state10(7))));
  records.push_back(resource(kHashKtx16, "ktx2-16x16-mips.ktx2"));
  records.push_back(resource(kHashKtx4, "ktx2-4x4.ktx2"));
  records.push_back(encode_transaction(make_full(state10(8))));
  records.push_back(encode_transaction(make_full(state10(9))));
  records.push_back(encode_transaction(make_full(state10(10))));
  End end = make_end(10, 0, 0, resource_count, resource_bytes, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("inline.rs10", all);
}

std::string text_of(const std::vector<std::uint8_t> &bytes) {
  return std::string(bytes.begin(), bytes.end());
}

// The item key order and the running offsets, read straight off the record text.
void test_item_keys_and_offsets() {
  const std::string t = text_of(encode_transaction(make_full(state10(9))));
  check(t.find("\"instance_params\":[],\"canvas_group\":{\"mode\":\"clip_only\",\"fit_empty\":false,"
               "\"blur_mipmaps\":false,\"f\":0},\"copy_to_backbuffer\":null,\"content_version\":1") !=
            std::string::npos,
        "item 10: canvas_group after instance_params, before content_version, f 0");
  check(t.find("\"canvas_group\":{\"mode\":\"clip_and_draw\",\"fit_empty\":false,"
               "\"blur_mipmaps\":false,\"f\":2}") != std::string::npos,
        "item 11: f 2 (item 10's group took two floats)");
  check(t.find("\"canvas_group\":{\"mode\":\"transparent\",\"fit_empty\":true,"
               "\"blur_mipmaps\":true,\"f\":4}") != std::string::npos,
        "item 12: f 4");
  check(t.find("\"canvas_group\":null,\"copy_to_backbuffer\":{\"f\":6}") != std::string::npos,
        "item 13: copy at f 6");
  check(t.find("\"canvas_group\":null,\"copy_to_backbuffer\":{\"f\":10}") != std::string::npos,
        "item 14: copy at f 10 (item 13's rect took four floats)");
  check(t.find("{\"name\":\"param_f64\",\"type\":\"f64\",\"count\":") != std::string::npos &&
            t.find("{\"name\":\"backbuffer_f32\",\"type\":\"f32\",\"count\":14}]") !=
                std::string::npos,
        "backbuffer_f32 is the seventh block, 14 floats");
  check(text_of(encode_transaction(make_full(state10(8)))).find(
            "{\"name\":\"backbuffer_f32\",\"type\":\"f32\",\"count\":0}]") != std::string::npos,
        "a /10 transaction always carries the seventh block, empty when nothing uses it");
}

// The diff engine: a back-buffer change alone is an item entry with commands null; a clear keeps
// the copy; a freed item is removed with its state.
void test_patch_semantics() {
  const Transaction patch = make_patch(state10(9), state10(10));
  bool saw12 = false;
  bool saw14 = false;
  for (const ItemEntry &e : patch.items) {
    if (e.state.id == 12) {
      saw12 = e.commands_null && e.state.canvas_group.fit_margin == 20.0f;
    }
    if (e.state.id == 14) {
      saw14 = !e.commands_null && e.state.copy_to_backbuffer && e.state.commands.empty();
    }
  }
  check(saw12, "a fit margin change alone is a patch entry with commands null");
  check(saw14, "a cleared item keeps its copy (and carries its emptied commands)");
  check(std::find(patch.removed_items.begin(), patch.removed_items.end(), 11u) !=
            patch.removed_items.end(),
        "a freed owner child leaves through removed_items");
}

// At /9 neither key and no seventh block is ever written, and a /9 patch carries no entry for a
// back-buffer change alone.
void test_fields_ignored_at_v9() {
  Snapshot with = state10(9);
  with.version = ProtocolVersion::V9;
  Snapshot without = with;
  for (ItemState &it : without.items) {
    it.canvas_group = CanvasGroupState();
    it.copy_to_backbuffer = false;
    it.copy_to_backbuffer_rect = kZeroRect;
  }
  const std::string t9 = text_of(encode_transaction(make_full(with)));
  check(encode_transaction(make_full(with)) == encode_transaction(make_full(without)),
        "a /9 transaction ignores both back-buffer keys");
  check(t9.find("canvas_group") == std::string::npos && t9.find("backbuffer") == std::string::npos,
        "a /9 transaction never names canvas_group or backbuffer_f32");
  Snapshot base = state10(9);
  base.version = ProtocolVersion::V9;
  Snapshot cur = base;
  cur.seq = 10;
  find(cur, 12)->canvas_group.fit_margin = 20.0f;
  find(cur, 13)->copy_to_backbuffer = false;
  const Transaction p9 = make_patch(base, cur);
  check(p9.items.empty(), "a /9 patch carries no entry for a back-buffer change alone");
  base.version = ProtocolVersion::V10;
  cur.version = ProtocolVersion::V10;
  check(make_patch(base, cur).items.size() == 2, "the same change at /10 is two entries");
}

// P3-TM (render-stream-10.md "Shader time"): the optional shader_time key, last before blocks, its
// value param_f64's last float; absent without a value and below /10; complete in a patch.
void test_shader_time() {
  Snapshot plain = state10(9);
  Snapshot timed = plain;
  timed.shader_time = 1.25;
  const std::string tp = text_of(encode_transaction(make_full(plain)));
  const std::string tt = text_of(encode_transaction(make_full(timed)));
  check(tp.find("shader_time") == std::string::npos, "no shader_time key without a value");
  const std::size_t at = tt.find(",\"shader_time\":{\"f\":");
  check(at != std::string::npos && tt.find("},\"blocks\":", at) != std::string::npos,
        "shader_time is the last key before blocks");
  const std::string count_key = "{\"name\":\"param_f64\",\"type\":\"f64\",\"count\":";
  const std::size_t cp = tp.find(count_key);
  const std::size_t ct = tt.find(count_key);
  check(cp != std::string::npos && ct != std::string::npos, "both declare param_f64");
  const long before = std::strtol(tp.c_str() + cp + count_key.size(), nullptr, 10);
  const long after = std::strtol(tt.c_str() + ct + count_key.size(), nullptr, 10);
  const long f = std::strtol(tt.c_str() + at + std::string(",\"shader_time\":{\"f\":").size(),
                             nullptr, 10);
  check(f == before && after == before + 1, "shader_time's f is the param count; one more float");
  Snapshot timed9 = timed;
  timed9.version = ProtocolVersion::V9;
  Snapshot plain9 = plain;
  plain9.version = ProtocolVersion::V9;
  check(encode_transaction(make_full(timed9)) == encode_transaction(make_full(plain9)),
        "a /9 transaction never carries shader_time");
  Snapshot next = timed;
  next.seq = timed.seq + 1;
  next.shader_time = 1.5;
  check(make_patch(timed, next).shader_time == std::optional<double>(1.5),
        "a patch carries the current shader_time (complete, never patched)");
}

void test_magic_and_protocol() {
  const std::vector<std::uint8_t> m = magic(ProtocolVersion::V10);
  check(m.size() == 8 && m[0] == 'G' && m[1] == 'R' && m[2] == 'S' && m[3] == 'A' &&
            m[4] == 0x0D && m[5] == 0x0A && m[6] == 0x1A && m[7] == 0x0A,
        "magic(V10) is GRSA\\r\\n\\x1a\\n");
  check(std::string(kProtocolV10) == "render-stream/10", "kProtocolV10 is render-stream/10");
  check(is_v7_or_later(ProtocolVersion::V10) && is_v8_or_later(ProtocolVersion::V10) &&
            is_v9_or_later(ProtocolVersion::V10) && is_v9_or_later(ProtocolVersion::V9) &&
            !is_v9_or_later(ProtocolVersion::V8),
        "V10 is V7, V8 and V9 or later; is_v9_or_later is V9 and V10 only");
  check(std::string(to_wire(CanvasGroupMode::ClipOnly)) == "clip_only" &&
            std::string(to_wire(CanvasGroupMode::ClipAndDraw)) == "clip_and_draw" &&
            std::string(to_wire(CanvasGroupMode::Transparent)) == "transparent",
        "canvas group mode spellings");
  const std::string session = text_of(encode_session(
      session10(Encoding::Full, std::string(32, '1'), std::string(32, 'a'), Delivery::OutOfBand)));
  check(session.find("\"protocol\":\"render-stream/10\"") != std::string::npos,
        "a /10 session names render-stream/10");
}

}  // namespace

int main() {
  test_magic_and_protocol();
  test_matches_golden_full_rs10();
  test_matches_golden_patch_rs10();
  test_matches_golden_inline_rs10();
  test_item_keys_and_offsets();
  test_patch_semantics();
  test_fields_ignored_at_v9();
  test_shader_time();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs10_codec_test: all checks passed\n");
  return 0;
}
