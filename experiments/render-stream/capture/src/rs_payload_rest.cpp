// TDR: payload bodies compressed at rest (rs_payload_rest.h).
#include "rs_payload_rest.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <thread>

#include "rs_http_coding.h"

namespace grc {
namespace rs {

namespace {

std::atomic<std::uint8_t> g_coding{static_cast<std::uint8_t>(RestCoding::Identity)};
std::atomic<bool> g_keep_identity{false};
std::atomic<std::thread::id> g_main_thread{};

struct AtomicInflate {
  std::atomic<std::uint64_t> count{0};
  std::atomic<std::uint64_t> coded_bytes{0};
  std::atomic<std::uint64_t> identity_bytes{0};
  std::atomic<std::uint64_t> ns{0};
};

struct AtomicStats {
  std::atomic<std::uint64_t> coded{0};
  std::atomic<std::uint64_t> not_smaller{0};
  std::atomic<std::uint64_t> in_bytes{0};
  std::atomic<std::uint64_t> out_bytes{0};
  std::atomic<std::uint64_t> code_ns{0};
  std::atomic<std::uint64_t> code_main_thread{0};
  AtomicInflate inflate[static_cast<std::size_t>(InflateSite::kCount)];
  std::atomic<std::uint64_t> inflate_failed{0};
};

AtomicStats &stats() {
  static AtomicStats s;
  return s;
}

std::uint64_t now_ns() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now().time_since_epoch())
                                        .count());
}

constexpr std::uint8_t kGrt1[8] = {0x47, 0x52, 0x54, 0x31, 0x0D, 0x0A, 0x1A, 0x0A};

}  // namespace

void set_rest_config(const RestConfig &config) {
  g_coding.store(static_cast<std::uint8_t>(config.coding), std::memory_order_release);
  g_keep_identity.store(config.keep_identity, std::memory_order_release);
}

RestConfig rest_config() {
  RestConfig out;
  out.coding = static_cast<RestCoding>(g_coding.load(std::memory_order_acquire));
  out.keep_identity = g_keep_identity.load(std::memory_order_acquire);
  return out;
}

const char *rest_coding_token(RestCoding coding) {
  switch (coding) {
    case RestCoding::Zstd:
      return "zstd";
    case RestCoding::Gzip:
      return "gzip";
    case RestCoding::Identity:
      break;
  }
  return "identity";
}

bool parse_rest_fault(const char *value, bool *keep_identity, std::string *error) {
  *keep_identity = false;
  if (value == nullptr || value[0] == '\0') {
    return true;
  }
  if (std::strcmp(value, "keep-identity") == 0) {
    *keep_identity = true;
    return true;
  }
  *error = std::string("GRC_AT_REST_FAULT must be keep-identity or unset, got '") + value + "'";
  return false;
}

bool rest_codable(const std::uint8_t *data, std::size_t size) {
  return data != nullptr && size > sizeof(kGrt1) + 64 && std::equal(kGrt1, kGrt1 + 8, data);
}

void code_at_rest(PayloadPtr *bytes) {
  if (bytes == nullptr || *bytes == nullptr || (*bytes)->coded()) {
    return;
  }
  const RestCoding coding = static_cast<RestCoding>(g_coding.load(std::memory_order_acquire));
  if (coding == RestCoding::Identity) {
    return;  // GRC_HTTP_ENCODING=off: nothing is coded, nothing is counted
  }
  const PayloadPtr identity = *bytes;
  identity->rest_tried = true;
  if (!rest_codable(identity->data(), identity->size())) {
    return;
  }
  AtomicStats &s = stats();
  const std::uint64_t t0 = now_ns();
  std::vector<std::uint8_t> out;
  const bool ok = coding == RestCoding::Zstd
                      ? http_coding::zstd_compress(identity->data(), identity->size(), &out)
                      : http_coding::gzip_compress(identity->data(), identity->size(), &out);
  s.code_ns.fetch_add(now_ns() - t0, std::memory_order_relaxed);
  if (std::this_thread::get_id() == g_main_thread.load(std::memory_order_relaxed)) {
    s.code_main_thread.fetch_add(1, std::memory_order_relaxed);
  }
  if (!ok || out.size() >= identity->size()) {
    s.not_smaller.fetch_add(1, std::memory_order_relaxed);
    return;
  }
  // An exact-size copy: the coder's buffer has ZSTD_compressBound (about the identity size) of
  // capacity, and keeping it would hold the identity's memory under a coded size.
  auto coded = std::make_shared<PayloadBytes>(out.begin(), out.end());
  out = std::vector<std::uint8_t>();
  coded->rest = coding;
  coded->identity_bytes = identity->size();
  coded->rest_tried = true;
  if (g_keep_identity.load(std::memory_order_acquire)) {
    coded->kept_identity = identity;  // the sabotage: the identity body stays held beside it
  }
  s.coded.fetch_add(1, std::memory_order_relaxed);
  s.in_bytes.fetch_add(identity->size(), std::memory_order_relaxed);
  s.out_bytes.fetch_add(coded->size(), std::memory_order_relaxed);
  *bytes = std::move(coded);
}

const char *inflate_site_name(InflateSite site) {
  switch (site) {
    case InflateSite::Get:
      return "get";
    case InflateSite::Store:
      return "store";
    case InflateSite::Inline:
      return "inline";
    case InflateSite::Basis:
      return "basis";
    case InflateSite::Sabotage:
      return "sabotage";
    case InflateSite::Restore:
      return "restore";
    case InflateSite::kCount:
      break;
  }
  return "?";
}

std::shared_ptr<const std::vector<std::uint8_t>> identity_of(const PayloadPtr &body,
                                                             InflateSite site) {
  if (body == nullptr || !body->coded()) {
    return body;
  }
  if (body->kept_identity != nullptr) {
    return body->kept_identity;
  }
  AtomicStats &s = stats();
  const std::uint64_t t0 = now_ns();
  auto out = std::make_shared<std::vector<std::uint8_t>>();
  out->reserve(static_cast<std::size_t>(body->identity_bytes));
  const bool ok = body->rest == RestCoding::Zstd
                      ? http_coding::zstd_decompress(body->data(), body->size(), out.get())
                      : http_coding::gzip_decompress(body->data(), body->size(), out.get());
  if (!ok || out->size() != body->identity_bytes) {
    s.inflate_failed.fetch_add(1, std::memory_order_relaxed);
    return nullptr;
  }
  AtomicInflate &slot = s.inflate[static_cast<std::size_t>(site)];
  slot.count.fetch_add(1, std::memory_order_relaxed);
  slot.coded_bytes.fetch_add(body->size(), std::memory_order_relaxed);
  slot.identity_bytes.fetch_add(out->size(), std::memory_order_relaxed);
  slot.ns.fetch_add(now_ns() - t0, std::memory_order_relaxed);
  return out;
}

RestStats rest_stats() {
  const AtomicStats &s = stats();
  RestStats out;
  out.coded = s.coded.load(std::memory_order_relaxed);
  out.not_smaller = s.not_smaller.load(std::memory_order_relaxed);
  out.in_bytes = s.in_bytes.load(std::memory_order_relaxed);
  out.out_bytes = s.out_bytes.load(std::memory_order_relaxed);
  out.code_ns = s.code_ns.load(std::memory_order_relaxed);
  out.code_main_thread = s.code_main_thread.load(std::memory_order_relaxed);
  for (std::size_t i = 0; i < static_cast<std::size_t>(InflateSite::kCount); ++i) {
    out.inflate[i].count = s.inflate[i].count.load(std::memory_order_relaxed);
    out.inflate[i].coded_bytes = s.inflate[i].coded_bytes.load(std::memory_order_relaxed);
    out.inflate[i].identity_bytes = s.inflate[i].identity_bytes.load(std::memory_order_relaxed);
    out.inflate[i].ns = s.inflate[i].ns.load(std::memory_order_relaxed);
  }
  out.inflate_failed = s.inflate_failed.load(std::memory_order_relaxed);
  return out;
}

void reset_rest_stats() {
  AtomicStats &s = stats();
  s.coded.store(0);
  s.not_smaller.store(0);
  s.in_bytes.store(0);
  s.out_bytes.store(0);
  s.code_ns.store(0);
  s.code_main_thread.store(0);
  for (AtomicInflate &slot : s.inflate) {
    slot.count.store(0);
    slot.coded_bytes.store(0);
    slot.identity_bytes.store(0);
    slot.ns.store(0);
  }
  s.inflate_failed.store(0);
}

void set_rest_main_thread() { g_main_thread.store(std::this_thread::get_id()); }

void RestCensus::add(const PayloadPtr &body, std::unordered_set<const void *> *seen) {
  if (body == nullptr || !seen->insert(body.get()).second) {
    return;
  }
  if (!body->coded() && !rest_codable(body->data(), body->size())) {
    return;  // not a GRT1 body the coding applies to (short): nothing to judge
  }
  ++bodies;
  held_bytes += body->held_bytes();
  capacity_slack_bytes += body->capacity() - body->size();
  identity_bytes += body->identity_size();
  if (body->coded()) {
    ++coded;
    if (body->kept_identity != nullptr) {
      identity_bytes_held += body->kept_identity->size();
    }
  } else if (body->rest_tried) {
    ++not_smaller;
  } else {
    ++untried;
    identity_bytes_held += body->size();
  }
}

}  // namespace rs
}  // namespace grc
