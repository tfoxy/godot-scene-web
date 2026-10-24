#include "rs_texture_basis.h"

#include <chrono>

#include "rs_basis_encode.h"
#include "rs_sha256.h"
#include "rs_texture_cache.h"

namespace grc {
namespace rs {

static_assert(kDefaultUastcLevel == ::rs::basis::kDefaultUastcLevel,
              "rs_texture_delivery.h and rs_basis_encode.h disagree on the default UASTC level");

namespace {
std::uint64_t now_ns() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                        std::chrono::steady_clock::now().time_since_epoch())
                                        .count());
}
}  // namespace

TextureWorkerPool &texture_encode_pool() {
  static TextureWorkerPool pool;
  return pool;
}

void run_basis_job(BasisJob *job, int level, bool perturb, bool corrupt) {
  BasisJob::Outcome out;
  // G8kc (D7, D8): a persisted encode of this source at these params is served instead of encoding
  // (verified against its name by the cache); a miss or a corrupt file encodes and stores.
  TextureCache &cache = texture_cache();
  const CacheKey key{job->cache_source(), "uastc",
                     ::rs::basis::params_id(level) != nullptr ? ::rs::basis::params_id(level) : ""};
  const bool keyed = cache.enabled() && cache_key_valid(key) && !corrupt;
  if (keyed) {
    std::vector<std::uint8_t> bytes;
    std::string hash;
    const CacheResult got = cache.get(key, &bytes, &hash);
    if (got == CacheResult::Hit) {
      out.cache = "hit";
      out.hash = hash;
      out.params = key.params;
      if (perturb && !bytes.empty()) {
        bytes.back() ^= 0x01;  // perturb-ktx2 applies to served bytes too, never to the cache
      }
      out.ktx2 = std::make_shared<const std::vector<std::uint8_t>>(std::move(bytes));
      out.ok = true;
      job->finish(std::move(out));
      return;
    }
    out.cache = got == CacheResult::Corrupt ? "corrupt" : "miss";
  }
  const auto source = job->source();
  std::vector<std::vector<std::uint8_t>> levels;
  if (source == nullptr || !grt1_rgba8_levels(*source, job->format(), job->width(), job->height(),
                                              job->mipmaps(), &levels)) {
    out.error = "decoded payload is not an RGBA8/RGB8 GRT1 of the entry's shape";
    job->finish(std::move(out));
    return;
  }
  std::vector<::rs::basis::Level> in;
  std::int64_t w = job->width();
  std::int64_t h = job->height();
  for (const std::vector<std::uint8_t> &l : levels) {
    in.push_back({static_cast<std::uint32_t>(w), static_cast<std::uint32_t>(h), l.data()});
    w = w > 1 ? w >> 1 : 1;
    h = h > 1 ? h >> 1 : 1;
  }
  texture_delivery_note_encode_run();
  const std::uint64_t t0 = now_ns();
  ::rs::basis::EncodeResult r = ::rs::basis::encode_uastc_ktx2(in.data(), in.size(), level);
  const std::uint64_t t1 = now_ns();
  out.encode_ns = t1 - t0;
  if (!r.ok) {
    out.error = r.error;
    job->finish(std::move(out));
    return;
  }
  if (corrupt && r.ktx2.size() > 104) {
    // KTX2 level index: 24-byte entries from byte 80, each led by the level's byte offset (LE u64).
    std::uint64_t at = 0;
    for (int i = 0; i < 8; ++i) at |= static_cast<std::uint64_t>(r.ktx2[80 + i]) << (8 * i);
    if (at < r.ktx2.size()) r.ktx2[at] ^= 0xFF;
  }
  out.hash = sha256_hex(r.ktx2.data(), r.ktx2.size());
  out.hash_ns = now_ns() - t1;
  out.params = r.params_id;
  if (keyed) {
    cache.put(key, out.hash, r.ktx2.data(), r.ktx2.size(), "ktx2");
  }
  if (perturb && !r.ktx2.empty()) {
    r.ktx2.back() ^= 0x01;  // perturb-ktx2: after hashing, so the bytes no longer match the hash
  }
  out.ktx2 = std::make_shared<const std::vector<std::uint8_t>>(std::move(r.ktx2));
  out.ok = true;
  job->finish(std::move(out));
}

bool submit_basis_job(const BasisJobPtr &job, int level, bool perturb, bool corrupt) {
  return texture_encode_pool().submit(
      [job, level, perturb, corrupt] { run_basis_job(job.get(), level, perturb, corrupt); });
}

}  // namespace rs
}  // namespace grc
