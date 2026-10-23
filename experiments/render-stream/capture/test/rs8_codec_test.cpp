// Unit tests for render-stream/8 (src/rs2_codec.cpp's and rs2_diff.cpp's Session::version == V8
// path, G8w).
//
// render-stream/8 is a protocol-version switch inside the SAME rs2_codec/rs2_diff modules /2-/7 use
// (render-stream-8.md, gate8-design.md D1), so this file proves only /8's delta: the GRS8 magic and
// the "render-stream/8" protocol string, the session keys `adoption` and `resources.decode`, the
// "adopted" origin and `adopted_content` in the texture/mesh tables (origin alone in the
// shader/material tables), the texture `source_format`, and the float payload formats -- by
// matching protocol/golden-8/{full,patch,inline,off}.rs8 byte for byte. It also proves that every
// field /8 adds is ignored below /8 (a V7 transaction built from /8-shaped structs is byte-equal
// to the same transaction built from created defaults), so /2-/7 output is unchanged.
//
// The six states mirror protocol/golden-8/make_golden.py: golden-6's states 1-3 (golden::state)
// plus three /8 states built here.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "rs2_codec.h"
#include "rs2_diff.h"
#include "rs2_golden_states.h"
#include "rs2_snapshot.h"

#ifndef GRC_GOLDEN8_DIR
#error "GRC_GOLDEN8_DIR must be defined by CMakeLists.txt"
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
  const std::vector<std::uint8_t> expected = read_file(std::string(GRC_GOLDEN8_DIR) + "/" + file);
  check(!expected.empty(), ("golden-8/" + file + " is readable").c_str());
  std::size_t offset = 0;
  for (std::size_t i = 0; i < records.size(); ++i) {
    const bool in_range = offset + records[i].size() <= expected.size();
    const bool matches = in_range && std::equal(records[i].begin(), records[i].end(),
                                                expected.begin() + static_cast<long>(offset));
    check(matches, ("record " + std::to_string(i) + " matches golden-8/" + file).c_str());
    offset += records[i].size();
  }
  check(offset == expected.size(),
        ("encoded recording is exactly golden-8/" + file + "'s length").c_str());
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

// protocol/golden-8/make_golden.py's payload hashes and whole-payload lengths (the index.json's
// "payloads", "mesh_payloads" and "shader_payloads").
const std::string kHashDec = "71b311777cc9812b1443591ca77bc8a8186b5269adc10fca7aff5c4818f9e510";
const std::string kHashRgbaf = "9ecc93d4dea0bb489a9801d18d92f58d1095d88cc976d50029c1a21fd195f48e";
const std::string kHashRh = "d689749c279ef7eb9c13091e1703669d24a69332b06c8b93d8253dad122256a2";
const std::string kHashMesh1A = "42532dc3a4f775e3426da84ca155a52da8b598594a396e68f364e1b220aa933a";
const std::string kHashMesh1B = "4353a1d85e83235c0041d2563ae73b0e54dfe6f37f7a859a5acb88aedae49474";
const std::string kHashShader = "2c874800cd97ba181708fd009b2ec9ab5c49e666c285a39427cf5f8ccf761310";

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

Snapshot state8(int n) {
  Snapshot s = golden::state(n <= 3 ? n : 3);
  s.version = ProtocolVersion::V8;
  s.seq = static_cast<std::uint64_t>(n);
  s.frame = static_cast<std::uint64_t>(n);
  if (n <= 3) {
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
  if (n >= 5) {
    s.textures[5].version = 2;
    s.textures[5].hash = golden::kHashA2;
    s.textures[5].payload_bytes = 1135;
    s.textures[5].adopted_content = AdoptedContent::Current;
    s.meshes[0].version = 2;
    s.meshes[0].adopted_content = AdoptedContent::Current;
    s.meshes[0].surfaces = {golden::mesh_surface(kHashMesh1B, 297, Primitive::Triangles,
                                                 golden::kMesh1SurfaceBFormat, 4, 6)};
  }
  if (n >= 6) {
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
  return s;
}

Session session8(Encoding encoding, const std::string &stream_id, const std::string &session_id,
                 Delivery delivery) {
  Session session = golden::golden_session_v6(encoding, stream_id, session_id, delivery);
  session.version = ProtocolVersion::V8;
  session.resources.permitted_formats = {"L8",   "LA8",  "R8",   "RG8",   "RGB8", "RGBA8",
                                         "RF",   "RGF",  "RGBF", "RGBAF", "RH",   "RGH",
                                         "RGBH", "RGBAH"};
  session.resources.decode = TextureDecode::Engine;
  session.adoption.present = true;
  session.adoption.frame = 12;
  return session;
}

void test_matches_golden_full_rs8() {
  const Session session = session8(Encoding::Full, golden::kFullStreamId, golden::kFullSessionId,
                                   Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V8));
  records.push_back(encode_session(session));
  for (int n = 1; n <= 6; ++n) {
    records.push_back(encode_transaction(make_full(state8(n))));
  }
  End end = make_end(6, 0, 0, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("full.rs8", all);
}

// Through make_patch(): seq 2-4 patch against their predecessor, seq 5 is a full resync, seq 6 a
// patch -- the diff engine carries the /8 fields (origin, adopted_content, source_format).
void test_matches_golden_patch_rs8() {
  const Session session = session8(Encoding::Patch, golden::kPatchStreamId, golden::kPatchSessionId,
                                   Delivery::OutOfBand);
  std::vector<std::vector<std::uint8_t>> records;
  records.push_back(magic(ProtocolVersion::V8));
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(make_full(state8(1))));
  for (int n = 2; n <= 4; ++n) {
    records.push_back(encode_transaction(make_patch(state8(n - 1), state8(n))));
  }
  records.push_back(encode_transaction(make_full(state8(5))));
  records.push_back(encode_transaction(make_patch(state8(5), state8(6))));
  End end = make_end(2, 4, 12345, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("patch.rs8", all);
}

void test_matches_golden_inline_rs8() {
  const Session session = session8(Encoding::Full, std::string(32, '3'),
                                   "22222222222222222222222222222222", Delivery::Inline);
  const std::string dir = std::string(GRC_GOLDEN8_DIR) + "/payloads/";
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
  records.push_back(magic(ProtocolVersion::V8));
  records.push_back(encode_session(session));
  records.push_back(resource(golden::kHashA1, "a1.grt"));
  records.push_back(resource(golden::kHashF, "f.grt"));
  records.push_back(encode_transaction(make_full(state8(1))));
  records.push_back(encode_transaction(make_full(state8(2))));
  records.push_back(resource(golden::kHashA2, "a2.grt"));
  records.push_back(encode_transaction(make_full(state8(3))));
  records.push_back(resource(kHashDec, "dec.grt"));
  records.push_back(resource(kHashRgbaf, "rgbaf.grt"));
  records.push_back(resource(kHashRh, "rh.grt"));
  records.push_back(resource(kHashMesh1A, "mesh1-a.grm"));
  records.push_back(resource(kHashShader, "shader2-tint-v1.grp"));
  records.push_back(encode_transaction(make_full(state8(4))));
  records.push_back(resource(kHashMesh1B, "mesh1-b.grm"));
  records.push_back(encode_transaction(make_full(state8(5))));
  records.push_back(encode_transaction(make_full(state8(6))));
  End end = make_end(6, 0, 0, resource_count, resource_bytes, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("inline.rs8", all);
}

// off.rs8: adoption null, decode "off", a websocket stream declaring a /8 sabotage kind.
void test_matches_golden_off_rs8() {
  Session session = session8(Encoding::Full, std::string(32, '4'),
                             "44444444444444444444444444444444", Delivery::OutOfBand);
  session.stream.transport = Transport::Websocket;
  session.adoption.present = false;
  session.resources.decode = TextureDecode::Off;
  session.sabotage.kind = SabotageKind::PerturbDecode;
  session.sabotage.frame = 1;
  session.sabotage.has_op = false;
  Snapshot snap;
  snap.version = ProtocolVersion::V8;
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
  records.push_back(magic(ProtocolVersion::V8));
  records.push_back(encode_session(session));
  records.push_back(encode_transaction(make_full(snap)));
  End end = make_end(1, 0, 0, 0, 0, records);
  std::vector<std::vector<std::uint8_t>> all = records;
  all.push_back(encode_end(end));
  check_against_golden("off.rs8", all);
}

// The session key order: `adoption` sits right after `unknown_item_policy` (or after `sabotage`
// when that key is absent), and `decode` ends the resources object.
void test_session_key_order() {
  Session session = session8(Encoding::Full, std::string(32, '1'), std::string(32, 'a'),
                             Delivery::OutOfBand);
  const auto text = [](const Session &s) {
    const std::vector<std::uint8_t> bytes = encode_session(s);
    return std::string(bytes.begin(), bytes.end());
  };
  std::string plain = text(session);
  const std::size_t sab = plain.find("\"sabotage\":");
  const std::size_t adoption = plain.find("\"adoption\":{\"mode\":\"arm\",\"frame\":12}");
  const std::size_t blocks = plain.find("\"blocks\":[");
  check(sab != std::string::npos && adoption != std::string::npos && blocks != std::string::npos &&
            sab < adoption && adoption < blocks,
        "/8 session: sabotage, adoption, blocks in that order");
  check(plain.find("\"unknown_item_policy\"") == std::string::npos,
        "a strict /8 session carries no unknown_item_policy");
  const std::size_t auth = plain.find("\"auth\":\"none\",\"decode\":\"engine\"}");
  check(auth != std::string::npos, "/8 session: resources.decode follows auth and ends the object");

  session.unknown_item_policy = UnknownItemPolicy::Skip;
  std::string skip = text(session);
  const std::size_t policy = skip.find("\"unknown_item_policy\":\"skip\"");
  const std::size_t adoption2 = skip.find("\"adoption\":");
  check(policy != std::string::npos && adoption2 != std::string::npos && policy < adoption2,
        "a skip /8 session: unknown_item_policy, then adoption");

  session.adoption.present = false;
  check(text(session).find("\"adoption\":null") != std::string::npos,
        "adoption off encodes as null, never omitted");
  check(plain.find("\"protocol\":\"render-stream/8\"") != std::string::npos,
        "a /8 session names render-stream/8");
}

// Below /8 none of the new fields is ever written: a /7 transaction and session built from
// /8-shaped structs equal the ones built from created defaults, byte for byte.
void test_fields_ignored_below_v8() {
  Snapshot adopted = state8(4);
  adopted.version = ProtocolVersion::V7;
  Snapshot plain = adopted;
  for (TextureEntry &t : plain.textures) {
    t.origin = Origin::Created;
    t.adopted_content = AdoptedContent::None;
    t.has_source_format = false;
    t.source_format.clear();
  }
  for (MeshEntry &m : plain.meshes) {
    m.origin = Origin::Created;
    m.adopted_content = AdoptedContent::None;
  }
  for (ShaderEntry &s : plain.shaders) {
    s.origin = Origin::Created;
  }
  for (MaterialEntry &m : plain.materials) {
    m.origin = Origin::Created;
  }
  check(encode_transaction(make_full(adopted)) == encode_transaction(make_full(plain)),
        "a /7 transaction ignores origin, adopted_content and source_format");
  Session s7 = golden::golden_session_v6(Encoding::Full, std::string(32, '1'),
                                         std::string(32, 'a'), Delivery::OutOfBand);
  s7.version = ProtocolVersion::V7;
  Session s7_adopting = s7;
  s7_adopting.adoption.present = true;
  s7_adopting.adoption.frame = 5;
  s7_adopting.resources.decode = TextureDecode::Engine;
  check(encode_session(s7) == encode_session(s7_adopting),
        "a /7 session ignores adoption and resources.decode");
  const std::vector<std::uint8_t> bytes = encode_session(s7);
  const std::string text(bytes.begin(), bytes.end());
  check(text.find("adoption") == std::string::npos && text.find("\"decode\"") == std::string::npos,
        "a /7 session never names adoption or decode");
}

void test_magic_and_protocol() {
  const std::vector<std::uint8_t> m = magic(ProtocolVersion::V8);
  check(m.size() == 8 && m[0] == 'G' && m[1] == 'R' && m[2] == 'S' && m[3] == '8' &&
            m[4] == 0x0D && m[5] == 0x0A && m[6] == 0x1A && m[7] == 0x0A,
        "magic(V8) is GRS8\\r\\n\\x1a\\n");
  check(std::string(kProtocolV8) == "render-stream/8", "kProtocolV8 is render-stream/8");
  check(is_v7_or_later(ProtocolVersion::V7) && is_v7_or_later(ProtocolVersion::V8) &&
            !is_v7_or_later(ProtocolVersion::V6),
        "is_v7_or_later is V7 and V8 only");
  for (SabotageKind kind :
       {SabotageKind::AdoptSkipState, SabotageKind::AdoptNoRedraw, SabotageKind::AdoptSkipLayers,
        SabotageKind::PerturbDecode, SabotageKind::SizeBeforeAdopt,
        SabotageKind::AdoptRawShaderCode, SabotageKind::AdoptSkipParams}) {
    check(std::string(to_wire(kind)).size() > 5, "a /8 sabotage kind has a wire spelling");
  }
  check(std::string(to_wire(SabotageKind::AdoptRawShaderCode)) == "adopt-raw-shader-code",
        "adopt-raw-shader-code spelling");
}

}  // namespace

int main() {
  test_magic_and_protocol();
  test_matches_golden_full_rs8();
  test_matches_golden_patch_rs8();
  test_matches_golden_inline_rs8();
  test_matches_golden_off_rs8();
  test_session_key_order();
  test_fields_ignored_below_v8();
  if (g_failures != 0) {
    std::fprintf(stderr, "%d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs8_codec_test: all checks passed\n");
  return 0;
}
