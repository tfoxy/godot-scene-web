// G2a: the GRT1 payload encoder (render-stream-2.md "Texture payload") on the
// four shapes protocol/golden-2/ uses (gate2-design.md "G2a" files), with the
// payload bytes written down here as literal expectations: the header in hex,
// the total length and the SHA-256 of the whole payload. The pixel contents are
// the gate 2 fixture's A0 (RGBA8 16x16 quadrants), the same pixels again (one
// shared hash), B (LA8 4x4 checker) and an RGBA8 8x8 with mipmaps whose 340
// data bytes are i % 251. The literals were derived independently with Python's
// struct + hashlib. G2b2 asserts byte equality with golden-2/payloads/.
//
// Also: the format-name table, expected_data_bytes over mip chains, and the
// GRC_RESOURCE_FORMATS / GRC_RESOURCE_MAX_PAYLOAD_BYTES parsers.
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "rs_sha256.h"
#include "rs_texture_payload.h"

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

std::vector<std::uint8_t> read_file(const std::string &path) {
  std::vector<std::uint8_t> out;
  std::FILE *file = std::fopen(path.c_str(), "rb");
  if (file == nullptr) {
    return out;
  }
  std::uint8_t buffer[4096];
  std::size_t n = 0;
  while ((n = std::fread(buffer, 1, sizeof(buffer), file)) > 0) {
    out.insert(out.end(), buffer, buffer + n);
  }
  std::fclose(file);
  return out;
}

std::uint32_t u32le(const std::vector<std::uint8_t> &b, std::size_t at) {
  return static_cast<std::uint32_t>(b[at]) | (static_cast<std::uint32_t>(b[at + 1]) << 8) |
         (static_cast<std::uint32_t>(b[at + 2]) << 16) |
         (static_cast<std::uint32_t>(b[at + 3]) << 24);
}

// The string value of `"key":"..."` in canonical JSON.
std::string json_string(const std::string &json, const std::string &key) {
  const std::string needle = "\"" + key + "\":\"";
  const std::size_t at = json.find(needle);
  if (at == std::string::npos) {
    return std::string();
  }
  const std::size_t start = at + needle.size();
  return json.substr(start, json.find('"', start) - start);
}

// The integer value of `"key":<digits>` in canonical JSON.
std::int64_t json_int(const std::string &json, const std::string &key) {
  const std::string needle = "\"" + key + "\":";
  const std::size_t at = json.find(needle);
  return at == std::string::npos ? -1 : std::stoll(json.substr(at + needle.size()));
}

std::vector<std::uint8_t> quadrants() {
  std::vector<std::uint8_t> data;
  for (int y = 0; y < 16; ++y) {
    for (int x = 0; x < 16; ++x) {
      const bool right = x >= 8;
      const bool bottom = y >= 8;
      std::uint8_t rgba[4] = {0, 0, 0, 255};
      if (!right && !bottom) {
        rgba[0] = 255;
      } else if (right && !bottom) {
        rgba[1] = 255;
      } else if (!right && bottom) {
        rgba[2] = 255;
      } else {
        rgba[0] = rgba[1] = rgba[2] = 255;
      }
      data.insert(data.end(), rgba, rgba + 4);
    }
  }
  return data;
}

struct Shape {
  const char *name;
  std::int64_t format;
  std::int64_t width;
  std::int64_t height;
  bool mipmaps;
  std::vector<std::uint8_t> data;
  std::size_t payload_bytes;
  const char *header_hex;
  const char *sha256;
};

}  // namespace

int main() {
  using namespace grc::rs;

  // Format table: the enum order of core/io/image.h:75-114.
  EXPECT(std::strcmp(image_format_name(0), "L8") == 0);
  EXPECT(std::strcmp(image_format_name(5), "RGBA8") == 0);
  EXPECT(std::strcmp(image_format_name(11), "RGBAF") == 0);
  EXPECT(std::strcmp(image_format_name(38), "ASTC_8x8_HDR") == 0);
  EXPECT(image_format_name(39) == nullptr);
  EXPECT(image_format_name(-1) == nullptr);
  EXPECT(image_format_from_name("LA8") == 1);
  EXPECT(image_format_from_name("ETC2_RA_AS_RG") == 33);
  EXPECT(image_format_from_name("rgba8") == -1);
  EXPECT(payload_pixel_size(4) == 3);
  EXPECT(payload_pixel_size(11) == 0);

  // Mip chains (core/io/image.cpp:1700-1745).
  EXPECT(expected_data_bytes(5, 16, 16, false) == 1024);
  EXPECT(expected_data_bytes(5, 8, 8, true) == 340);
  EXPECT(expected_data_bytes(5, 64, 64, true) == 4 * (4096 + 1024 + 256 + 64 + 16 + 4 + 1));
  EXPECT(expected_data_bytes(1, 4, 4, false) == 32);
  EXPECT(expected_data_bytes(4, 5, 3, true) == 3 * (15 + 2 + 1));  // 5x3, 2x1, 1x1
  EXPECT(expected_data_bytes(0, 1, 1, true) == 1);
  EXPECT(expected_data_bytes(11, 4, 4, false) == -1);
  EXPECT(expected_data_bytes(5, 0, 4, false) == -1);

  std::vector<std::uint8_t> la8;
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 4; ++x) {
      const std::uint8_t v = (x + y) % 2 == 0 ? 255 : 0;
      la8.push_back(v);
      la8.push_back(v);
    }
  }
  std::vector<std::uint8_t> mip;
  for (int i = 0; i < 340; ++i) {
    mip.push_back(static_cast<std::uint8_t>(i % 251));
  }
  const std::vector<Shape> shapes = {
      {"rgba8-16x16-quadrants", 5, 16, 16, false, quadrants(), 1135,
       "475254310d0a1a0a5f0000007b2274797065223a22746578747572652d3264222c22666f726d6174223a2252"
       "47424138222c227769647468223a31362c22686569676874223a31362c226d69706d617073223a66616c7365"
       "2c22646174615f6279746573223a313032347d00040000",
       "2b32ed0e3bfd92c67895bcee4e12740184bdc0fc21569c3da9bc399cb3d52d94"},
      {"rgba8-16x16-twin", 5, 16, 16, false, quadrants(), 1135, nullptr,
       "2b32ed0e3bfd92c67895bcee4e12740184bdc0fc21569c3da9bc399cb3d52d94"},
      {"la8-4x4-checker", 1, 4, 4, false, la8, 137,
       "475254310d0a1a0a590000007b2274797065223a22746578747572652d3264222c22666f726d6174223a224c"
       "4138222c227769647468223a342c22686569676874223a342c226d69706d617073223a66616c73652c226461"
       "74615f6279746573223a33327d20000000",
       "010fa78f5252bba55d7f689e94974819078dbe444ca78233993e50f709184047"},
      {"rgba8-8x8-mipmaps", 5, 8, 8, true, mip, 447,
       "475254310d0a1a0a5b0000007b2274797065223a22746578747572652d3264222c22666f726d6174223a2252"
       "47424138222c227769647468223a382c22686569676874223a382c226d69706d617073223a747275652c2264"
       "6174615f6279746573223a3334307d54010000",
       "24016e03058080695f56e21e778c163874f7ada8da42b6ea7dbe92c5d20e1b07"},
  };
  for (const Shape &s : shapes) {
    EXPECT(expected_data_bytes(s.format, s.width, s.height, s.mipmaps) ==
           static_cast<std::int64_t>(s.data.size()));
    const std::vector<std::uint8_t> payload =
        encode_payload(s.format, s.width, s.height, s.mipmaps, s.data.data(), s.data.size());
    if (payload.size() != s.payload_bytes) {
      std::fprintf(stderr, "FAIL %s: %zu payload bytes, want %zu\n", s.name, payload.size(),
                   s.payload_bytes);
      ++g_failures;
      continue;
    }
    const std::size_t header = payload.size() - s.data.size();
    if (s.header_hex != nullptr && hex(payload.data(), header) != s.header_hex) {
      std::fprintf(stderr, "FAIL %s: header %s\n", s.name, hex(payload.data(), header).c_str());
      ++g_failures;
    }
    EXPECT(std::memcmp(payload.data() + header, s.data.data(), s.data.size()) == 0);
    const std::string digest = grc::sha256_hex(payload.data(), payload.size());
    if (digest != s.sha256) {
      std::fprintf(stderr, "FAIL %s: sha256 %s want %s\n", s.name, digest.c_str(), s.sha256);
      ++g_failures;
    }
    // The split form the hook uses: header, then the data appended.
    const std::string meta =
        payload_meta(image_format_name(s.format), s.width, s.height, s.mipmaps,
                     static_cast<std::int64_t>(s.data.size()));
    std::vector<std::uint8_t> split;
    payload_header(meta, s.data.size(), &split);
    EXPECT(split.size() == header);
    split.insert(split.end(), s.data.begin(), s.data.end());
    EXPECT(split == payload);
    EXPECT(payload_size(meta, s.data.size()) == s.payload_bytes);
  }

  // GRC_RESOURCE_FORMATS.
  FormatPolicy policy;
  std::string error;
  EXPECT(parse_format_policy(nullptr, &policy, &error));
  EXPECT(policy.names == (std::vector<std::string>{"L8", "LA8", "R8", "RG8", "RGB8", "RGBA8"}));
  EXPECT(policy.permitted[5] && policy.permitted[0] && !policy.permitted[11]);
  EXPECT(parse_format_policy("RGBA8,LA8,RGBA8", &policy, &error));
  EXPECT(policy.names == (std::vector<std::string>{"LA8", "RGBA8"}));
  EXPECT(!policy.permitted[0]);
  EXPECT(!parse_format_policy("RGBA8,RGBAF", &policy, &error));
  EXPECT(error.find("RGBAF") != std::string::npos);
  EXPECT(!parse_format_policy("RGBA8,", &policy, &error));

  // GRC_RESOURCE_MAX_PAYLOAD_BYTES.
  std::uint64_t max_bytes = 0;
  EXPECT(parse_max_payload_bytes(nullptr, &max_bytes, &error));
  EXPECT(max_bytes == kDefaultMaxPayloadBytes);
  EXPECT(parse_max_payload_bytes("1135", &max_bytes, &error) && max_bytes == 1135);
  EXPECT(!parse_max_payload_bytes("0", &max_bytes, &error));
  EXPECT(!parse_max_payload_bytes("12k", &max_bytes, &error));

  // G2b2: the encoder re-derives every golden-2 payload byte for byte from the shape and data
  // the golden file itself carries (protocol/golden-2/payloads/, written by make_golden.py).
  int goldens = 0;
  for (const char *name : {"a1", "a2", "f", "p"}) {
    const std::vector<std::uint8_t> file =
        read_file(std::string(GRC_GOLDEN2_DIR) + "/payloads/" + name + ".grt");
    EXPECT(file.size() > 16);
    if (file.size() <= 16) {
      continue;
    }
    const std::uint32_t meta_len = u32le(file, 8);
    const std::string meta(file.begin() + 12, file.begin() + 12 + meta_len);
    const std::uint32_t data_len = u32le(file, 12 + meta_len);
    const std::size_t data_at = 16 + meta_len;
    EXPECT(data_at + data_len == file.size());
    const std::string format = json_string(meta, "format");
    const std::int64_t width = json_int(meta, "width");
    const std::int64_t height = json_int(meta, "height");
    const bool mipmaps = meta.find("\"mipmaps\":true") != std::string::npos;
    const std::vector<std::uint8_t> again =
        encode_payload(image_format_from_name(format), width, height, mipmaps,
                       file.data() + data_at, data_len);
    EXPECT(again == file);
    EXPECT(payload_meta(format.c_str(), width, height, mipmaps, data_len) == meta);
    ++goldens;
  }
  EXPECT(goldens == 4);

  if (g_failures != 0) {
    std::fprintf(stderr, "rs_texture_payload_test: %d failure(s)\n", g_failures);
    return 1;
  }
  std::printf("rs_texture_payload_test: ok\n");
  return 0;
}
