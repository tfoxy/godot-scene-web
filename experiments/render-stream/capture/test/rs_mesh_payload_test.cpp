// G5a: the GRM1 mesh payload encoder (gate5-design.md Q4 "Mesh payload render-stream-mesh/1")
// and D7's format classification, with one payload's bytes written down as a literal expectation
// (header in hex, total length, SHA-256 of the whole payload), derived independently with
// Python's struct + hashlib. G5w/G5e will assert byte equality with a committed golden once the
// wire exists; this test is engine-free and has no golden of its own yet.
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "abi.h"
#include "rs_mesh_payload.h"
#include "rs_sha256.h"

namespace {

int g_failures = 0;

#define EXPECT(cond)                                                     \
  do {                                                                   \
    if (!(cond)) {                                                       \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++g_failures;                                                      \
    }                                                                    \
  } while (0)

std::string hex(const std::uint8_t *data, std::size_t size) {
  static const char kDigits[] = "0123456789abcdef";
  std::string out;
  for (std::size_t i = 0; i < size; ++i) {
    out.push_back(kDigits[data[i] >> 4]);
    out.push_back(kDigits[data[i] & 0xf]);
  }
  return out;
}

}  // namespace

int main() {
  using namespace grc::rs;
  using grc::AABB;
  using grc::Vector3;
  using grc::Vector4;

  // Primitive names (servers/rendering_server.h:357-364).
  EXPECT(std::strcmp(mesh_primitive_name(0), "points") == 0);
  EXPECT(std::strcmp(mesh_primitive_name(3), "triangles") == 0);
  EXPECT(std::strcmp(mesh_primitive_name(4), "triangle_strip") == 0);
  EXPECT(mesh_primitive_name(5) == nullptr);  // PRIMITIVE_MAX
  EXPECT(mesh_primitive_name(-1) == nullptr);

  // D7: ok only for 2D positions, no compressed attributes, no blend shapes, and only the
  // VERTEX/COLOR/TEX_UV/BONES/WEIGHTS/INDEX format bits.
  SurfaceFacts facts;
  facts.primitive = 3;
  facts.format = kArrayFormatVertex | kArrayFlagUse2dVertices;
  facts.vertex_count = 3;
  EXPECT(classify_surface(facts).ok);

  SurfaceFacts not_2d = facts;
  not_2d.format = kArrayFormatVertex;  // no ARRAY_FLAG_USE_2D_VERTICES
  SurfaceClassification c = classify_surface(not_2d);
  EXPECT(!c.ok && c.reason == "mesh-format");

  SurfaceFacts compressed = facts;
  compressed.format |= kArrayFlagCompressAttributes;
  c = classify_surface(compressed);
  EXPECT(!c.ok && c.reason == "mesh-format");

  SurfaceFacts with_normal = facts;
  with_normal.format |= kArrayFormatNormal;
  c = classify_surface(with_normal);
  EXPECT(!c.ok && c.reason == "mesh-format");

  SurfaceFacts with_uv2 = facts;
  with_uv2.format |= kArrayFormatTexUv2;
  c = classify_surface(with_uv2);
  EXPECT(!c.ok && c.reason == "mesh-format");

  SurfaceFacts with_custom = facts;
  with_custom.format |= kArrayFormatCustom0;
  c = classify_surface(with_custom);
  EXPECT(!c.ok && c.reason == "mesh-format");

  SurfaceFacts bad_primitive = facts;
  bad_primitive.primitive = 5;  // PRIMITIVE_MAX
  c = classify_surface(bad_primitive);
  EXPECT(!c.ok && c.reason == "mesh-format");

  SurfaceFacts blend_shapes = facts;
  blend_shapes.blend_shape_data_bytes = 12;
  c = classify_surface(blend_shapes);
  EXPECT(!c.ok && c.reason == "mesh-blend-shapes");

  // Blend-shapes is checked ahead of a disallowed format bit: the contract names it as its own
  // typed refusal, independent of D7's format rule.
  SurfaceFacts both = not_2d;
  both.blend_shape_data_bytes = 12;
  c = classify_surface(both);
  EXPECT(c.reason == "mesh-blend-shapes");

  // COLOR, TEX_UV, BONES+WEIGHTS and INDEX are all allowed alongside VERTEX.
  SurfaceFacts full = facts;
  full.format |= kArrayFormatColor | kArrayFormatTexUv | kArrayFormatBones | kArrayFormatWeights |
                 kArrayFormatIndex;
  EXPECT(classify_surface(full).ok);

  // A literal GRM1 payload: one triangle, 2D positions only, no attribute/skin/index buffers.
  // Bytes computed independently with Python's struct + hashlib.
  const std::vector<std::uint8_t> vertex(24, 0xab);
  const std::uint64_t format = kArrayFormatVertex | kArrayFlagUse2dVertices;
  const AABB aabb{Vector3{1.5f, -2.25f, 0.0f}, Vector3{10.125f, 20.5f, 0.0f}};
  const Vector4 uv_scale{1.0f, 2.5f, -3.0f, 0.5f};
  const std::vector<std::uint8_t> payload =
      encode_payload(3, format, 3, 0, aabb, uv_scale, vertex.data(), vertex.size(), nullptr, 0,
                     nullptr, 0, nullptr, 0);
  const char *kHeaderHex =
      "47524d310d0a1a0aa70000007b2274797065223a226d6573682d73757266616365222c227072696d6974697665"
      "223a22747269616e676c6573222c22666f726d6174223a33333535343433332c227665727465785f636f756e74"
      "223a332c22696e6465785f636f756e74223a302c227665727465785f6279746573223a32342c2261747472696275"
      "74655f6279746573223a302c22736b696e5f6279746573223a302c22696e6465785f6279746573223a307d0000c0"
      "3f000010c000000000000022410000a441000000000000803f00002040000040c00000003f";
  const char *kSha256 = "068af5875c4b2b977a608cd013d2065451b49d2741434fb17006b456216f14d8";
  EXPECT(payload.size() == 243);
  const std::size_t header = payload.size() - vertex.size();
  if (hex(payload.data(), header) != kHeaderHex) {
    std::fprintf(stderr, "FAIL header: %s\n", hex(payload.data(), header).c_str());
    ++g_failures;
  }
  EXPECT(std::memcmp(payload.data() + header, vertex.data(), vertex.size()) == 0);
  const std::string digest = grc::sha256_hex(payload.data(), payload.size());
  if (digest != kSha256) {
    std::fprintf(stderr, "FAIL sha256: %s want %s\n", digest.c_str(), kSha256);
    ++g_failures;
  }

  // The split form the hook uses: header (meta + geometry), then the data appended.
  const std::string meta = payload_meta(3, format, 3, 0, static_cast<std::int64_t>(vertex.size()),
                                        0, 0, 0);
  std::vector<std::uint8_t> split;
  payload_header(meta, aabb, uv_scale, vertex.size(), &split);
  EXPECT(split.size() == header);
  split.insert(split.end(), vertex.begin(), vertex.end());
  EXPECT(split == payload);
  EXPECT(mesh_payload_size(meta, vertex.size()) == payload.size());

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_mesh_payload_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_mesh_payload_test: ok\n");
  return 0;
}
