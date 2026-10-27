// W11t: codes a recording's messages as a live /11 connection under a live coding would send them
// (rs_live_coding.h), through the capture's own encoder. The first message is the magic plus the
// session record, every later record one message; a transaction's base is the previous
// transaction in the file (a file sink's B, which a window-1 live connection's base equals).
//
//   rs_live_coding_tool encode <recording> <out.coded> [--coding zstd-base|zstd]
//                      [--stats <out.jsonl>] [--repeats N]
//
// <out.coded> is u32le length + message, repeated (rs-core coding::split_messages; rs-core-check
// live-decode reads it). --stats writes one JSON line per transaction: seq, frame, encoding, raw
// and coded bytes, base_seq, encode_us (the minimum over --repeats encodes, default 1), and the
// resource records sent before it (count, raw and coded bytes).
// Exits 1 on any coding failure or on a coded message that does not decode back.
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "rs_live_coding.h"

namespace lc = grc::rs::live_coding;

namespace {

std::uint32_t u32(const std::vector<std::uint8_t> &b, std::size_t at) {
  return static_cast<std::uint32_t>(b[at]) | (static_cast<std::uint32_t>(b[at + 1]) << 8) |
         (static_cast<std::uint32_t>(b[at + 2]) << 16) |
         (static_cast<std::uint32_t>(b[at + 3]) << 24);
}

// The value of `"key":` in a record's meta (digits or a quoted string), "" when absent.
std::string field(const std::string &meta, const std::string &key) {
  const std::string needle = "\"" + key + "\":";
  const std::size_t at = meta.find(needle);
  if (at == std::string::npos) return "";
  std::size_t b = at + needle.size();
  if (meta[b] == '"') return meta.substr(b + 1, meta.find('"', b + 1) - b - 1);
  std::size_t e = b;
  while (e < meta.size() && meta[e] != ',' && meta[e] != '}') ++e;
  return meta.substr(b, e - b);
}

void put(std::FILE *f, const std::vector<std::uint8_t> &m) {
  const std::uint32_t n = static_cast<std::uint32_t>(m.size());
  const std::uint8_t len[4] = {static_cast<std::uint8_t>(n), static_cast<std::uint8_t>(n >> 8),
                               static_cast<std::uint8_t>(n >> 16),
                               static_cast<std::uint8_t>(n >> 24)};
  std::fwrite(len, 1, 4, f);
  std::fwrite(m.data(), 1, m.size(), f);
}

}  // namespace

int main(int argc, char **argv) {
  if (argc < 4 || std::string(argv[1]) != "encode") {
    std::fprintf(stderr,
                 "usage: rs_live_coding_tool encode <recording> <out.coded> [--coding "
                 "zstd-base|zstd] [--stats <out.jsonl>] [--repeats N]\n");
    return 2;
  }
  lc::Coding coding = lc::Coding::ZstdBase;
  std::string stats_path;
  int repeats = 1;
  for (int i = 4; i + 1 < argc; i += 2) {
    const std::string k = argv[i];
    if (k == "--coding") {
      std::string error;
      if (!lc::parse_env(argv[i + 1], &coding, &error) || coding == lc::Coding::Off) {
        std::fprintf(stderr, "--coding must be zstd-base or zstd\n");
        return 2;
      }
    } else if (k == "--stats") {
      stats_path = argv[i + 1];
    } else if (k == "--repeats") {
      repeats = std::max(1, std::atoi(argv[i + 1]));
    }
  }
  std::ifstream in(argv[2], std::ios::binary);
  const std::vector<std::uint8_t> data((std::istreambuf_iterator<char>(in)),
                                       std::istreambuf_iterator<char>());
  if (data.size() < 12) {
    std::fprintf(stderr, "%s: not a recording\n", argv[2]);
    return 1;
  }
  std::FILE *out = std::fopen(argv[3], "wb");
  std::FILE *stats = stats_path.empty() ? nullptr : std::fopen(stats_path.c_str(), "w");
  if (out == nullptr || (!stats_path.empty() && stats == nullptr)) {
    std::fprintf(stderr, "cannot write the outputs\n");
    return 1;
  }
  std::size_t at = 8;
  bool first = true;
  std::vector<std::uint8_t> base;
  std::uint64_t base_seq = 0;
  std::uint64_t messages = 0, prefixed = 0, raw_total = 0, coded_total = 0;
  std::uint64_t records_raw = 0, records_coded = 0, records = 0;  // since the last transaction
  while (at + 4 <= data.size()) {
    const std::size_t len = 4 + u32(data, at);
    if (at + len > data.size()) {
      std::fprintf(stderr, "truncated record at %zu\n", at);
      return 1;
    }
    std::vector<std::uint8_t> message;
    if (first) {
      message.assign(data.begin(), data.begin() + static_cast<std::ptrdiff_t>(at + len));
    } else {
      message.assign(data.begin() + static_cast<std::ptrdiff_t>(at),
                     data.begin() + static_cast<std::ptrdiff_t>(at + len));
    }
    const std::string meta(reinterpret_cast<const char *>(data.data() + at + 8),
                           u32(data, at + 4));
    const bool tx = !first && meta.rfind("{\"type\":\"transaction\"", 0) == 0;
    std::vector<std::uint8_t> coded;
    double best_us = 1e18;
    std::uint64_t seq = 0, use_base = 0;
    if (tx) {
      seq = std::stoull(field(meta, "seq"));
      const bool full = field(meta, "encoding") == "full";
      use_base = (!full && coding == lc::Coding::ZstdBase) ? base_seq : 0;
      if (!full && std::to_string(base_seq) != field(meta, "base_seq")) {
        std::fprintf(stderr, "seq %llu: base_seq %s is not the previous transaction %llu\n",
                     static_cast<unsigned long long>(seq), field(meta, "base_seq").c_str(),
                     static_cast<unsigned long long>(base_seq));
        return 1;
      }
    }
    for (int r = 0; r < repeats; ++r) {
      const auto t0 = std::chrono::steady_clock::now();
      const bool ok =
          tx ? lc::encode_transaction(message.data(), message.size(), seq,
                                      use_base != 0 ? base.data() : nullptr,
                                      use_base != 0 ? base.size() : 0, use_base, &coded)
             : lc::encode_plain(message.data(), message.size(), &coded);
      const double us =
          std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
      if (!ok) {
        std::fprintf(stderr, "encode failed at record offset %zu\n", at);
        return 1;
      }
      best_us = std::min(best_us, us);
    }
    std::vector<std::uint8_t> back;
    std::uint64_t got_seq = 0, got_base = 0;
    std::string error;
    if (!lc::decode(coded.data(), coded.size(), use_base != 0 ? &base : nullptr, &back, &got_seq,
                    &got_base, &error) ||
        back != message || got_seq != seq || got_base != use_base) {
      std::fprintf(stderr, "record at %zu does not decode back: %s\n", at, error.c_str());
      return 1;
    }
    put(out, coded);
    ++messages;
    prefixed += use_base != 0 ? 1 : 0;
    raw_total += message.size();
    coded_total += coded.size();
    if (tx) {
      if (stats != nullptr) {
        std::fprintf(stats,
                     "{\"seq\":%llu,\"frame\":%s,\"encoding\":\"%s\",\"base_seq\":%llu,"
                     "\"raw_bytes\":%zu,\"coded_bytes\":%zu,\"encode_us\":%.1f,"
                     "\"records\":%llu,\"records_raw_bytes\":%llu,\"records_coded_bytes\":%llu}\n",
                     static_cast<unsigned long long>(seq), field(meta, "frame").c_str(),
                     field(meta, "encoding").c_str(), static_cast<unsigned long long>(use_base),
                     message.size(), coded.size(), best_us, static_cast<unsigned long long>(records),
                     static_cast<unsigned long long>(records_raw),
                     static_cast<unsigned long long>(records_coded));
      }
      records = records_raw = records_coded = 0;
      base = std::move(message);
      base_seq = seq;
    } else if (!first) {
      ++records;
      records_raw += message.size();
      records_coded += coded.size();
    }
    first = false;
    at += len;
  }
  std::fclose(out);
  if (stats != nullptr) std::fclose(stats);
  std::printf("{\"messages\":%llu,\"prefixed\":%llu,\"raw_bytes\":%llu,\"coded_bytes\":%llu}\n",
              static_cast<unsigned long long>(messages), static_cast<unsigned long long>(prefixed),
              static_cast<unsigned long long>(raw_total),
              static_cast<unsigned long long>(coded_total));
  return 0;
}
