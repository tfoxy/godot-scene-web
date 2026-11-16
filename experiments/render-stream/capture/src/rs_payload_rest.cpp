// TDR: payload bodies compressed at rest (rs_payload_rest.h).
#include "rs_payload_rest.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <new>
#include <system_error>
#include <thread>

#include "rs_http_coding.h"

namespace grc {
namespace rs {

namespace {

std::atomic<std::uint8_t> g_coding{static_cast<std::uint8_t>(RestCoding::Identity)};
std::atomic<std::uint8_t> g_sibling{static_cast<std::uint8_t>(RestCoding::Identity)};
// Every PayloadBytes::sibling, and each RestSibling's fields.
std::mutex g_sibling_mutex;
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
  std::atomic<std::uint64_t> sib_made{0};
  std::atomic<std::uint64_t> sib_not_smaller{0};
  std::atomic<std::uint64_t> sib_failed{0};
  std::atomic<std::uint64_t> sib_dropped{0};
  std::atomic<std::uint64_t> sib_in_bytes{0};
  std::atomic<std::uint64_t> sib_out_bytes{0};
  std::atomic<std::uint64_t> sib_ns{0};
  std::atomic<std::uint64_t> sib_misses{0};
  std::atomic<std::uint64_t> sib_streamed{0};
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
  g_sibling.store(static_cast<std::uint8_t>(config.sibling), std::memory_order_release);
  g_keep_identity.store(config.keep_identity, std::memory_order_release);
}

RestConfig rest_config() {
  RestConfig out;
  out.coding = static_cast<RestCoding>(g_coding.load(std::memory_order_acquire));
  out.sibling = static_cast<RestCoding>(g_sibling.load(std::memory_order_acquire));
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
    case InflateSite::Sibling:
      return "sibling";
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
  out.sibling.made = s.sib_made.load(std::memory_order_relaxed);
  out.sibling.not_smaller = s.sib_not_smaller.load(std::memory_order_relaxed);
  out.sibling.failed = s.sib_failed.load(std::memory_order_relaxed);
  out.sibling.dropped = s.sib_dropped.load(std::memory_order_relaxed);
  out.sibling.in_bytes = s.sib_in_bytes.load(std::memory_order_relaxed);
  out.sibling.out_bytes = s.sib_out_bytes.load(std::memory_order_relaxed);
  out.sibling.ns = s.sib_ns.load(std::memory_order_relaxed);
  out.sibling.misses = s.sib_misses.load(std::memory_order_relaxed);
  out.sibling.streamed = s.sib_streamed.load(std::memory_order_relaxed);
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
  for (std::atomic<std::uint64_t> *n : {&s.sib_made, &s.sib_not_smaller, &s.sib_failed, &s.sib_dropped,
                                        &s.sib_in_bytes, &s.sib_out_bytes, &s.sib_ns, &s.sib_misses,
                                        &s.sib_streamed}) {
    n->store(0);
  }
}

namespace {

std::atomic<bool> g_sibling_cancel{false};
std::atomic<int> g_sibling_level{kSiblingGzipLevel};
std::atomic<std::size_t> g_sibling_block{kSiblingBlockBytes};
std::atomic<int> g_sibling_threads{0};  // 0: default_sibling_threads()

// Ends a sibling encode: Ready with `bytes`, or Failed (none kept, never retried for this body).
// The stream's readers are left to the caller (they finish their copy either way).
void sibling_end(const std::shared_ptr<RestSibling> &sib, std::shared_ptr<const std::vector<std::uint8_t>> bytes) {
  std::lock_guard<std::mutex> lock(g_sibling_mutex);
  sib->bytes = std::move(bytes);
  sib->state = sib->bytes != nullptr ? RestSibling::State::Ready : RestSibling::State::Failed;
  sib->stream.reset();  // readers already following it keep their own reference
}

void count_inflate(InflateSite site, std::uint64_t coded_bytes, std::uint64_t identity_bytes, std::uint64_t ns) {
  AtomicInflate &slot = stats().inflate[static_cast<std::size_t>(site)];
  slot.count.fetch_add(1, std::memory_order_relaxed);
  slot.coded_bytes.fetch_add(coded_bytes, std::memory_order_relaxed);
  slot.identity_bytes.fetch_add(identity_bytes, std::memory_order_relaxed);
  slot.ns.fetch_add(ns, std::memory_order_relaxed);
}

// The streamed gzip encode of a zstd body: one thread inflates the identity into a buffer while
// the parallel deflate follows it block by block, each chunk going to the readers as it is done.
// Returns whether a whole member was emitted; `*inflated` whether the identity was whole.
bool stream_gzip_of_zstd(const PayloadBytes &body, const std::function<void(std::vector<std::uint8_t> &&)> &emit,
                         bool *inflated) {
  const std::size_t n = static_cast<std::size_t>(body.identity_bytes);
  std::unique_ptr<std::uint8_t[]> identity(new (std::nothrow) std::uint8_t[n > 0 ? n : 1]);
  if (identity == nullptr) {
    *inflated = false;
    return false;
  }
  std::mutex m;
  std::condition_variable cv;
  std::size_t avail = 0;  // leading identity bytes inflated, under m
  bool source_ended = false;
  bool source_ok = false;
  const auto inflate = [&] {
    const std::uint64_t t0 = now_ns();
    const bool ok = http_coding::zstd_decompress_progressive(
        body.data(), body.size(), identity.get(), n, [&](std::size_t written) {
          if (g_sibling_cancel.load(std::memory_order_acquire)) return false;
          {
            std::lock_guard<std::mutex> lock(m);
            avail = written;
          }
          cv.notify_all();
          return true;
        });
    if (ok) count_inflate(InflateSite::Sibling, body.size(), n, now_ns() - t0);
    {
      std::lock_guard<std::mutex> lock(m);
      source_ended = true;
      source_ok = ok;
    }
    cv.notify_all();
  };
  std::thread inflater;
  try {
    inflater = std::thread(inflate);
  } catch (const std::system_error &) {
    inflate();  // no thread to spare: inflate first, then encode
  }
  http_coding::GzipParallel config;
  config.level = g_sibling_level.load(std::memory_order_relaxed);
  config.block_bytes = g_sibling_block.load(std::memory_order_relaxed);
  config.threads = g_sibling_threads.load(std::memory_order_relaxed);
  if (config.threads <= 0) config.threads = default_sibling_threads();
  config.ready = [&](std::size_t end) {
    std::unique_lock<std::mutex> lock(m);
    cv.wait(lock, [&] { return avail >= end || source_ended; });
    return avail >= end;
  };
  const bool coded = http_coding::gzip_parallel(identity.get(), n, config, emit, &g_sibling_cancel);
  if (inflater.joinable()) inflater.join();
  if (!source_ok) stats().inflate_failed.fetch_add(1, std::memory_order_relaxed);
  *inflated = source_ok;
  return coded && source_ok;
}

// One sibling encode as queued. Destroyed without having run (the pool dropped it at stream end,
// or refused it), it ends the encode as failed: its body's readers keep getting the identity, and
// a reader already following the stream is ended (its response is cut short).
struct SiblingTask {
  PayloadPtr body;
  std::shared_ptr<RestSibling> sib;
  std::shared_ptr<BodyStream> stream;
  bool ran = false;
  SiblingTask() = default;
  SiblingTask(const SiblingTask &) = delete;
  SiblingTask &operator=(const SiblingTask &) = delete;
  ~SiblingTask() {
    if (!ran && sib != nullptr) {
      stats().sib_dropped.fetch_add(1, std::memory_order_relaxed);
      sibling_end(sib, nullptr);
      stream->finish(false);
    }
  }
  void run() {
    ran = true;
    AtomicStats &s = stats();
    std::atomic<std::uint64_t> *outcome = &s.sib_failed;  // inflate or coder failed
    std::shared_ptr<const std::vector<std::uint8_t>> kept;
    std::uint64_t identity_size = body->identity_size();
    const std::uint64_t t0 = now_ns();
    bool whole = false;  // the stream's chunks are a whole member in sib->coding
    {
      std::vector<BodyStream::Chunk> chunks;
      std::uint64_t total = 0;
      const auto emit = [&](std::vector<std::uint8_t> &&bytes) {
        auto chunk = std::make_shared<const std::vector<std::uint8_t>>(std::move(bytes));
        total += chunk->size();
        chunks.push_back(chunk);
        stream->append(std::move(chunk));
      };
      if (body->rest == RestCoding::Zstd && sib->coding == RestCoding::Gzip) {
        bool inflated = false;
        whole = stream_gzip_of_zstd(*body, emit, &inflated);
        if (!whole && g_sibling_cancel.load(std::memory_order_acquire)) {
          outcome = &s.sib_dropped;  // cut short by the stream's end
        }
      } else {
        // Any other pair (a gzip body with a zstd sibling): one inflate, one coder, one chunk.
        const std::shared_ptr<const std::vector<std::uint8_t>> identity = identity_of(body, InflateSite::Sibling);
        if (identity != nullptr) {
          std::vector<std::uint8_t> out;
          whole = sib->coding == RestCoding::Zstd
                      ? http_coding::zstd_compress(identity->data(), identity->size(), &out)
                      : http_coding::gzip_compress(identity->data(), identity->size(), &out);
          if (whole) emit(std::vector<std::uint8_t>(out.begin(), out.end()));  // exact size
        }
      }
      s.sib_ns.fetch_add(now_ns() - t0, std::memory_order_relaxed);
      if (whole && total >= identity_size) {
        outcome = &s.sib_not_smaller;  // its readers still get a whole (larger) member
      } else if (whole) {
        // The at-rest copy: the chunks spliced once into one exact-size body.
        auto joined = std::make_shared<std::vector<std::uint8_t>>();
        joined->reserve(static_cast<std::size_t>(total));
        for (const BodyStream::Chunk &c : chunks) joined->insert(joined->end(), c->begin(), c->end());
        kept = std::move(joined);
        outcome = &s.sib_made;
      }
    }
    const std::uint64_t kept_size = kept != nullptr ? kept->size() : 0;
    sibling_end(sib, std::move(kept));
    stream->finish(whole);
    // Counted after the body is visible: a reader that sees `made` also gets the body.
    if (outcome == &s.sib_made) {
      s.sib_in_bytes.fetch_add(identity_size, std::memory_order_relaxed);
      s.sib_out_bytes.fetch_add(kept_size, std::memory_order_relaxed);
    }
    outcome->fetch_add(1, std::memory_order_relaxed);
    body.reset();  // the pool may keep the closure a while; the body is not its to hold
  }
};

}  // namespace

int default_sibling_threads() {
  const unsigned hw = std::thread::hardware_concurrency();
  return static_cast<int>(std::clamp<unsigned>(hw > 1 ? hw - 1 : 1, 1, 4));
}

void set_sibling_tuning(int level, std::size_t block_bytes, int threads) {
  g_sibling_level.store(level > 0 ? level : kSiblingGzipLevel, std::memory_order_relaxed);
  g_sibling_block.store(block_bytes > 0 ? block_bytes : kSiblingBlockBytes, std::memory_order_relaxed);
  g_sibling_threads.store(threads, std::memory_order_relaxed);
}

void set_sibling_cancel(bool cancel) { g_sibling_cancel.store(cancel, std::memory_order_release); }

bool start_sibling(const PayloadPtr &body, const SiblingSubmit &submit) {
  const RestCoding coding = static_cast<RestCoding>(g_sibling.load(std::memory_order_acquire));
  if (!submit || body == nullptr || !body->coded() || coding == RestCoding::Identity || coding == body->rest) {
    return false;
  }
  auto task = std::make_shared<SiblingTask>();
  {
    std::lock_guard<std::mutex> lock(g_sibling_mutex);
    if (body->sibling != nullptr) {
      return false;  // already made, being made, or failed: one encode per body
    }
    body->sibling = std::make_shared<RestSibling>();
    body->sibling->coding = coding;
    body->sibling->stream = std::make_shared<BodyStream>();
    task->sib = body->sibling;
    task->stream = body->sibling->stream;
  }
  task->body = body;
  // Outside the mutex: a refused task is destroyed here, which marks the encode failed.
  return submit([task] { task->run(); });
}

std::shared_ptr<const std::vector<std::uint8_t>> sibling_body(const PayloadPtr &body, RestCoding coding,
                                                              std::shared_ptr<BodyStream> *stream) {
  if (body == nullptr || coding == RestCoding::Identity) {
    return nullptr;
  }
  std::shared_ptr<const std::vector<std::uint8_t>> out;
  bool following = false;
  {
    std::lock_guard<std::mutex> lock(g_sibling_mutex);
    const std::shared_ptr<RestSibling> &sib = body->sibling;
    if (sib != nullptr && sib->coding == coding) {
      if (sib->state == RestSibling::State::Ready) {
        out = sib->bytes;
      } else if (sib->state == RestSibling::State::Pending && stream != nullptr && sib->stream != nullptr) {
        *stream = sib->stream;
        following = true;
      }
    }
  }
  if (following) {
    stats().sib_streamed.fetch_add(1, std::memory_order_relaxed);
  } else if (out == nullptr && body->coded() && coding != body->rest &&
             coding == static_cast<RestCoding>(g_sibling.load(std::memory_order_acquire))) {
    stats().sib_misses.fetch_add(1, std::memory_order_relaxed);  // none to give: identity instead
  }
  return out;
}

std::shared_ptr<const std::vector<std::uint8_t>> sibling_bytes(const PayloadPtr &body, RestCoding coding) {
  return sibling_body(body, coding, nullptr);
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
  {
    std::lock_guard<std::mutex> lock(g_sibling_mutex);
    if (body->sibling != nullptr && body->sibling->state == RestSibling::State::Ready) {
      ++siblings;
      sibling_bytes += body->sibling->bytes->size();
    }
  }
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
