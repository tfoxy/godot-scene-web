// Unit tests for render-stream/9 (src/rs2_codec.cpp's and rs2_diff.cpp's Session::version == V9
// path, G8k9).
//
// render-stream/9 is a protocol-version switch inside the SAME rs2_codec/rs2_diff modules /2-/8 use
// (render-stream-9.md, texture-delivery-design.md D4/Q5), so this file proves only /9's delta: the
// GRS9 magic and the "render-stream/9" protocol string, the session key
// `resources.texture_delivery`, and the texture-entry `variants` list (block and uastc, including
// a variant appearing at an equal version, which the diff engine must carry as a patch entry) --
// by matching protocol/golden-9/{full,patch,inline,off}.rs9 byte for byte. It also proves that
// both additions are ignored at /8 (a V8 transaction built from variant-carrying structs is
// byte-equal to the same transaction without them), so /2-/8 output is unchanged.
//
// The eight states mirror protocol/golden-9/make_golden.py: golden-9's six states (state9() below,
// copied from rs8_codec_test.cpp) plus two /9 states built here.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"

#ifndef GRC_GOLDEN9_DIR
#error "GRC_GOLDEN9_DIR must be defined by CMakeLists.txt"
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
  const std::vector<std::uint8_t> expected = read_file(std::string(GRC_GOLDEN9_DIR) + "/" + file);
  check(!expected.empty(), ("golden-9/" + file + " is readable").c_str());
  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-9/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(),
        ("encoded recording is exactly golden-9/" + file + "'s length").c_str());
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
    s.items.erase_if([](const ItemState &it) { return it.id == 6; });
    s.canvases.mut(0) = golden::root_canvas({1, 2, 3, 4, 5, 8});
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
    s.canvases.mut(0) = golden::root_canvas({1, 2, 3, 4, 5, 8, 9});
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

void test_matches_golden_full_rs9() {
  const Session session = session9(Encoding::Full, golden::kFullStreamId, golden::kFullSessionId,
                                   Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V9));
  records.push_back(encode_session(session));
  for (int n = 1; n <= 8; ++n) {
    records.push_back(encode_transaction(make_full(state9(n))));
  }
  End end = make_end(8, 0, 0, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("full.rs9", all);
}

// Through make_patch(): seq 2-4 patch against their predecessor, seq 5 is a full resync, seq 6 a
// patch -- the diff engine carries the /8 fields (origin, adopted_content, source_format).
void test_matches_golden_patch_rs9() {
  const Session session = session9(Encoding::Patch, golden::kPatchStreamId, golden::kPatchSessionId,
                                   Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V9));
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(make_full(state9(1))));
  for (int n = 2; n <= 4; ++n) {
    records.push_back(encode_transaction(make_patch(state9(n - 1), state9(n))));
  }
  records.push_back(encode_transaction(make_full(state9(5))));
  for (int n = 6; n <= 8; ++n) {
    records.push_back(encode_transaction(make_patch(state9(n - 1), state9(n))));
  }
  End end = make_end(2, 6, 12345, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("patch.rs9", all);
}

void test_matches_golden_inline_rs9() {
  const Session session = session9(Encoding::Full, std::string(32, '3'),
                                   "22222222222222222222222222222222", Delivery::Inline);
  const std::string dir = std::string(GRC_GOLDEN9_DIR) + "/payloads/";
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
  records.push_back(magic(ProtocolVersion::V9));
  records.push_back(encode_session(session));
  records.push_back(resource(golden::kHashA1, "a1.grt"));
  records.push_back(resource(golden::kHashF, "f.grt"));
  records.push_back(encode_transaction(make_full(state9(1))));
  records.push_back(encode_transaction(make_full(state9(2))));
  records.push_back(resource(golden::kHashA2, "a2.grt"));
  records.push_back(encode_transaction(make_full(state9(3))));
  records.push_back(resource(kHashDec, "dec.grt"));
  records.push_back(resource(kHashRgbaf, "rgbaf.grt"));
  records.push_back(resource(kHashRh, "rh.grt"));
  records.push_back(resource(kHashMesh1A, "mesh1-a.grm"));
  records.push_back(resource(kHashShader, "shader2-tint-v1.grp"));
  records.push_back(encode_transaction(make_full(state9(4))));
  records.push_back(resource(kHashMesh1B, "mesh1-b.grm"));
  records.push_back(encode_transaction(make_full(state9(5))));
  records.push_back(encode_transaction(make_full(state9(6))));
  records.push_back(resource(kHashMip16, "mip16.grt"));
  records.push_back(resource(kHashDxt5x16m, "dxt5-16x16-mips.grt"));
  records.push_back(resource(kHashDxt5x4, "dxt5-4x4.grt"));
  records.push_back(encode_transaction(make_full(state9(7))));
  records.push_back(resource(kHashKtx16, "ktx2-16x16-mips.ktx2"));
  records.push_back(resource(kHashKtx4, "ktx2-4x4.ktx2"));
  records.push_back(encode_transaction(make_full(state9(8))));
  End end = make_end(8, 0, 0, resource_count, resource_bytes, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("inline.rs9", all);
}

// off.rs9: mode "rgba", encoder null, a websocket stream declaring a /8 sabotage kind.
void test_matches_golden_off_rs9() {
  Session session = session9(Encoding::Full, std::string(32, '4'),
                             "44444444444444444444444444444444", Delivery::OutOfBand);
  session.stream.transport = Transport::Websocket;
  session.adoption.present = false;
  session.resources.decode = TextureDecode::Off;
  session.resources.texture_delivery.mode = "rgba";
  session.resources.texture_delivery.has_encoder = false;
  session.sabotage.kind = SabotageKind::PerturbDecode;
  session.sabotage.frame = 1;
  session.sabotage.has_op = false;
  Snapshot snap;
  snap.version = ProtocolVersion::V9;
  snap.seq = 1;
  snap.frame = 1;
  snap.default_texture_filter = Filter::Nearest;
  snap.default_texture_repeat = Repeat::Disabled;
  snap.canvases = {golden::root_canvas({1})};
  ItemState it;
  it.id = 1;
  it.parent = ParentRef{ParentKind::Canvas, 1};
  it.content_version = 1;
  it.commands = {golden::add_rect({0.0f, 0.0f, 8.0f, 8.0f}, kWhite)};
  snap.items = {it};
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V9));
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(make_full(snap)));
  End end = make_end(1, 0, 0, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("off.rs9", all);
}

// The session key order: `texture_delivery` follows `decode` and ends the resources object; the
// other /8 keys stay where /8 put them.
void test_session_key_order() {
  Session session = session9(Encoding::Full, std::string(32, '1'), std::string(32, 'a'),
                             Delivery::OutOfBand);
  const auto text = [](const Session &s) {
    const std::vector<std::uint8_t> bytes = encode_session(s);
    return std::string(bytes.begin(), bytes.end());
  };
  const std::string plain = text(session);
  check(plain.find("\"auth\":\"none\",\"decode\":\"engine\",\"texture_delivery\":"
                   "{\"mode\":\"basis-uastc\",\"encoder\":\"basisu-1.60\"}}") !=
            std::string::npos,
        "/9 session: resources.texture_delivery follows decode and ends the object");
  const std::size_t sab = plain.find("\"sabotage\":");
  const std::size_t adoption = plain.find("\"adoption\":{\"mode\":\"arm\",\"frame\":12}");
  const std::size_t blocks = plain.find("\"blocks\":[");
  check(sab != std::string::npos && adoption != std::string::npos && blocks != std::string::npos &&
            sab < adoption && adoption < blocks,
        "/9 session: sabotage, adoption, blocks in that order");
  check(plain.find("\"protocol\":\"render-stream/9\"") != std::string::npos,
        "a /9 session names render-stream/9");
  session.resources.texture_delivery.mode = "rgba";
  session.resources.texture_delivery.has_encoder = false;
  check(text(session).find("\"texture_delivery\":{\"mode\":\"rgba\",\"encoder\":null}") !=
            std::string::npos,
        "the encoder encodes as null, never omitted");
}

// At /8 neither addition is ever written: a /8 transaction built from variant-carrying structs
// equals the one built without them, and a /8 session ignores the delivery declaration.
void test_fields_ignored_at_v8() {
  Snapshot with = state9(8);
  with.version = ProtocolVersion::V8;
  Snapshot without = with;
  for (TextureEntry &t : without.textures) {
    t.variants.clear();
  }
  bool any = false;
  for (const TextureEntry &t : with.textures) {
    any = any || !t.variants.empty();
  }
  check(any, "the /9 state 8 does carry variants");
  check(encode_transaction(make_full(with)) == encode_transaction(make_full(without)),
        "a /8 transaction ignores variants");
  Session s8 = golden::golden_session_v6(Encoding::Full, std::string(32, '1'),
                                         std::string(32, 'a'), Delivery::OutOfBand);
  s8.version = ProtocolVersion::V8;
  Session s8_declaring = s8;
  s8_declaring.resources.texture_delivery.mode = "basis-etc1s";
  s8_declaring.resources.texture_delivery.has_encoder = true;
  s8_declaring.resources.texture_delivery.encoder = "basisu-1.60";
  check(encode_session(s8) == encode_session(s8_declaring),
        "a /8 session ignores resources.texture_delivery");
  const std::vector<std::uint8_t> bytes = encode_session(s8);
  const std::string text(bytes.begin(), bytes.end());
  check(text.find("texture_delivery") == std::string::npos,
        "a /8 session never names texture_delivery");
  // The one-patch-entry rule (texture-delivery-design.md D6): a variant appearing at an equal
  // version is a changed entry, so the diff carries it.
  const Transaction patch = make_patch(state9(6), state9(7));
  bool carried = false;
  for (const TextureEntry &t : patch.textures) {
    carried = carried || (t.id == 7 && t.version == 1 && t.variants.size() == 1);
  }
  check(carried, "a variant appearing at an equal version is a patch entry");
}

void test_magic_and_protocol() {
  const std::vector<std::uint8_t> m = magic(ProtocolVersion::V9);
  check(m.size() == 8 && m[0] == 'G' && m[1] == 'R' && m[2] == 'S' && m[3] == '9' &&
            m[4] == 0x0D && m[5] == 0x0A && m[6] == 0x1A && m[7] == 0x0A,
        "magic(V9) is GRS9\\r\\n\\x1a\\n");
  check(std::string(kProtocolV9) == "render-stream/9", "kProtocolV9 is render-stream/9");
  check(is_v7_or_later(ProtocolVersion::V7) && is_v7_or_later(ProtocolVersion::V8) &&
            is_v7_or_later(ProtocolVersion::V9) && !is_v7_or_later(ProtocolVersion::V6),
        "is_v7_or_later is V7, V8 and V9 only");
  check(is_v8_or_later(ProtocolVersion::V8) && is_v8_or_later(ProtocolVersion::V9) &&
            !is_v8_or_later(ProtocolVersion::V7),
        "is_v8_or_later is V8 and V9 only");
  check(std::string(to_wire(TextureReason::DeliveryPending)) == "delivery-pending",
        "delivery-pending spelling");
  check(std::string(to_wire(VariantEncoding::Block)) == "block" &&
            std::string(to_wire(VariantEncoding::Uastc)) == "uastc" &&
            std::string(to_wire(VariantEncoding::Etc1s)) == "etc1s",
        "variant encoding spellings");
}

}  // namespace

int main() {
  test_magic_and_protocol();
  test_matches_golden_full_rs9();
  test_matches_golden_patch_rs9();
  test_matches_golden_inline_rs9();
  test_matches_golden_off_rs9();
  test_session_key_order();
  test_fields_ignored_at_v8();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs9_codec_test: all checks passed\n");
  return 0;
}
