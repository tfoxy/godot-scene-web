// W11t: the live coding's host half (rs_live_coding.h; render-stream-11.md "As built (W11t)"):
// the env and hello grammar, the envelope's layout, the frame parameters, round trips with and
// without a base, and a wrong base. The golden pins (golden-11/coding/*.coded, the coded form of
// golden-11's recordings) are separate ctests over rs_live_coding_tool.
#include <cstdio>
#include <string>
#include <vector>

#include "rs_live_coding.h"

namespace lc = grc::rs::live_coding;

namespace {
int failures = 0;
int checks = 0;
void check(bool ok, const std::string &what) {
  ++checks;
  if (!ok) {
    ++failures;
    std::printf("FAIL %s\n", what.c_str());
  }
}

std::vector<std::uint8_t> sample(int variant) {
  std::string s;
  for (int i = 0; i < 400; ++i) {
    s += "{\"id\":" + std::to_string(i) + ",\"x\":" + std::to_string((i * 7 + variant) % 97) + "}";
  }
  return std::vector<std::uint8_t>(s.begin(), s.end());
}
}  // namespace

int main() {
  lc::Coding c = lc::Coding::Off;
  std::string error;
  check(lc::parse_env(nullptr, &c, &error) && c == lc::Coding::ZstdBase, "default zstd-base");
  check(lc::parse_env("", &c, &error) && c == lc::Coding::ZstdBase, "empty is the default");
  check(lc::parse_env("zstd", &c, &error) && c == lc::Coding::Zstd, "zstd");
  check(lc::parse_env("off", &c, &error) && c == lc::Coding::Off, "off");
  check(!lc::parse_env("gzip", &c, &error), "gzip refused");
  check(lc::valid_offer("zstd-base,zstd") && lc::valid_offer("zstd") &&
            !lc::valid_offer("zstd,") && !lc::valid_offer(",zstd") && !lc::valid_offer("") &&
            !lc::valid_offer("ZSTD") && !lc::valid_offer(std::string(97, 'a')),
        "the offer grammar");

  const std::vector<std::uint8_t> base = sample(1);
  const std::vector<std::uint8_t> target = sample(2);
  std::vector<std::uint8_t> coded;
  check(lc::encode_transaction(target.data(), target.size(), 7, base.data(), base.size(), 6,
                               &coded),
        "encode a based transaction");
  const std::uint8_t env[24] = {0x5b, 0x2a, 0x4d, 0x18, 16, 0, 0, 0, 7, 0, 0, 0,
                                0,    0,    0,    0,    6,  0, 0, 0, 0, 0, 0, 0};
  check(coded.size() > 28 && std::equal(env, env + 24, coded.begin()),
        "envelope: skippable magic 0x184D2A5B, 16 bytes, seq 7, base 6");
  check(coded[24] == 0x28 && coded[25] == 0xb5 && coded[26] == 0x2f && coded[27] == 0xfd,
        "then a zstd frame");
  // Frame header descriptor: bit 2 content checksum, bits 6-7 FCS field size or single segment.
  const std::uint8_t fhd = coded[28];
  check((fhd & 0x04) != 0, "the frame carries a content checksum");
  check((fhd & 0x03) == 0, "the frame names no dictionary");
  check((fhd >> 6) != 0 || (fhd & 0x20) != 0, "the frame carries its content size");
  std::vector<std::uint8_t> back;
  std::uint64_t seq = 0, base_seq = 0;
  check(lc::decode(coded.data(), coded.size(), &base, &back, &seq, &base_seq, &error) &&
            back == target && seq == 7 && base_seq == 6,
        "round trip against its base " + error);
  std::vector<std::uint8_t> plain_tx;
  check(lc::encode_transaction(target.data(), target.size(), 7, nullptr, 0, 0, &plain_tx) &&
            plain_tx.size() > coded.size(),
        "the base prefix shrinks the frame: " + std::to_string(coded.size()) + " < " +
            std::to_string(plain_tx.size()));
  std::vector<std::uint8_t> wrong = base;
  wrong.push_back(0);
  check(!lc::decode(coded.data(), coded.size(), &wrong, &back, &seq, &base_seq, &error) ||
            back != target,
        "a wrong base does not give the target back");
  std::vector<std::uint8_t> p;
  check(lc::encode_plain(target.data(), target.size(), &p) && p[0] == 0x28 &&
            lc::decode(p.data(), p.size(), nullptr, &back, &seq, &base_seq, &error) &&
            back == target && seq == 0 && base_seq == 0,
        "plain-coded round trip");
  std::vector<std::uint8_t> twice;
  check(lc::encode_transaction(target.data(), target.size(), 7, base.data(), base.size(), 6,
                               &twice) &&
            twice == coded,
        "coding is deterministic (lockstep viewers can share it)");
  std::printf("rs_live_coding_test: %d checks, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
