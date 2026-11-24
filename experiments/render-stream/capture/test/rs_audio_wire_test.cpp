#include "rs_audio_wire.h"
#include "rs_json_lite.h"
#include <bit>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
using namespace grc::audio;
using grc::rs::json_lite::JValue;
namespace {
const JValue &at(const JValue &v, const char *name) { const auto *p = v.get(name); if (!p) throw std::runtime_error(name); return *p; }
std::string str(const JValue &v, const char *name) { return at(v, name).text; }
std::uint64_t num(const JValue &v, const char *name) { return std::stoull(str(v, name)); }
void expect(bool ok, const char *what) { if (!ok) throw std::runtime_error(what); }
BlockHeader header(const JValue &v) {
  BlockHeader h;
  h.kind = num(v,"kind"); h.flags = num(v,"flags"); h.lane = num(v,"lane"); h.codec = num(v,"codec"); h.channels = num(v,"channels");
  h.stream = num(v,"stream"); h.block = num(v,"block"); h.rate = num(v,"rate"); h.frames = num(v,"frames");
  h.made_us = num(v,"made_us"); h.due_us = num(v,"due_us"); h.sent_us = num(v,"sent_us"); return h;
}
LinkMessage message(const JValue &v) {
  LinkMessage m; m.type = num(v,"type");
  switch (m.type) {
    case 0:
      m.version = num(v,"version"); m.clock_domain = str(v,"clock_domain"); m.bankset = str(v,"bankset");
      for (const auto &l : at(v,"lanes").items) m.lanes.push_back({static_cast<std::uint8_t>(num(l,"id")), str(l,"name"), str(l,"group")});
      break;
    case 1: m.block = unhex(str(v,"block")); break;
    case 2: m.key_id = str(v,"key_id"); m.stream = num(v,"stream"); m.frames = num(v,"frames"); break;
    case 3: m.key_id = str(v,"key_id"); m.stream = num(v,"stream"); m.wav_sha256 = str(v,"wav_sha256"); break;
    case 4: m.key_id = str(v,"key_id"); m.reason = num(v,"reason"); break;
    case 5: m.key_id = str(v,"key_id"); m.t_us = num(v,"t_us"); m.key = str(v,"key"); break;
    case 6: m.lane_mask = num(v,"lane_mask"); break;
  }
  return m;
}
void judge(const std::string &group, const JValue &v) {
  const bool valid = at(v,"valid").b;
  try {
    if (group == "keys") {
      std::vector<std::pair<std::string, float>> params;
      for (const auto &p : at(v,"params").items) params.emplace_back(str(p,"name"), std::bit_cast<float>(static_cast<std::uint32_t>(std::stoul(str(p,"bits"), nullptr, 16))));
      const auto key = canonical_key(str(v,"path"), params);
      expect(valid, "accepted invalid key"); expect(key == str(v,"canonical"), "canonical spelling differs"); expect(key_id(key) == str(v,"key_id"), "keyId differs");
    } else if (group == "blocks") {
      BlockContext c; c.lane_mask = 0; c.lane_block_frames = num(v,"lane_block_frames");
      for (const auto &id : at(v,"lanes").items) c.lane_mask |= 1u << std::stoul(id.text);
      const auto b = decode_block(unhex(str(v,"hex")), c); expect(valid, "accepted invalid block");
      const auto h = header(at(v,"header")); expect(b.header == h, "decoded header differs"); expect(hex(b.payload) == str(v,"payload"), "decoded PCM differs");
      expect(hex(encode_block(h, unhex(str(v,"payload")), c)) == str(v,"hex"), "encoded block differs");
    } else if (group == "links") {
      const auto m = decode_link(unhex(str(v,"hex"))); expect(valid, "accepted invalid link");
      const auto expected = message(at(v,"message")); expect(m == expected, "decoded link differs"); expect(hex(encode_link(expected)) == str(v,"hex"), "encoded link differs");
    } else {
      const auto p = decode_prefix(unhex(str(v,"hex"))); expect(valid, "accepted invalid prefix");
      MediaPrefix expected; expected.kind = num(v,"kind");
      if (expected.kind == 2) expected.key_id = str(v,"key_id"); else expected.lane = num(v,"lane");
      expect(p == expected, "decoded prefix differs"); expect(hex(encode_prefix(expected)) == str(v,"hex"), "encoded prefix differs");
    }
  } catch (const std::invalid_argument &) { if (valid) throw; }
}
}
int main() {
  std::ifstream in(GRC_AUDIO_VECTORS);
  const std::string text((std::istreambuf_iterator<char>(in)), {});
  JValue root; if (!grc::rs::json_lite::Reader(text).parse(&root)) { std::cerr << "cannot load audio vectors\n"; return 1; }
  int passed = 0, failed = 0;
  for (const std::string group : {"keys", "blocks", "links", "prefixes"}) {
    for (const auto &v : at(root, group.c_str()).items) {
      try { judge(group, v); ++passed; }
      catch (const std::exception &e) { std::cerr << group << "/" << str(v,"name") << ": " << e.what() << "\n"; ++failed; }
    }
  }
  std::cout << passed << " passed, " << failed << " failed, 0 skipped\n";
  return failed ? 1 : 0;
}
