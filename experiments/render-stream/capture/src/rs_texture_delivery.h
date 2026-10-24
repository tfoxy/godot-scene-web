// The texture-delivery seam (texture-delivery-design.md D1, D4, D5, D6; G8k9 landed the seam, the
// G8kp/G8ku/G8ke increments fill it).
//
// GRC_TEXTURE_DELIVERY=rgba|passthrough|basis-uastc|basis-etc1s (D1, default rgba) names the
// variants the host offers per texture. At /9 the session declares the mode and the encoder
// (`resources.texture_delivery`), and each ok image texture entry lists the variants the host has
// ready (`variants`, D5/D6). G8k9 landed the wire and the plumbing (the mode parsed and declared,
// the encoder null, no variant). G8kp fills `passthrough`: a block-compressed source that the host
// decodes (G8t) also keeps its hooked bytes as a `block` variant, a GRT1 payload in the source's
// own block format (render-stream-9.md "Texture payload"), hashed where the decoded payload is
// (the calling thread, or G8kw's worker). G8ku fills `basis-uastc`: on top of passthrough's
// variants, every D12-eligible image gets a `uastc` variant (a KTX2 payload), encoded lazily on the
// encode pool (rs_texture_basis.h) and published per D6 as a patch entry with one more variant at
// an equal `version`. `basis-etc1s` stays refused at /9 (`delivery_mode_implemented`) until G8ke. Below /9 nothing here runs: the hooks build a
// block payload only when `texture_delivery_block_enabled()` (a /9 stream under a mode offering
// `block`), and the codec never writes the key, so the seam changes no existing byte.
//
// Pure C++17, no engine types: unit-testable without a Godot process (rs_gate8_policy_test).
#ifndef GRC_RS_TEXTURE_DELIVERY_H
#define GRC_RS_TEXTURE_DELIVERY_H

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs {

struct DeliveryPolicy {
  std::string mode = "rgba";  // rgba | passthrough | basis-uastc | basis-etc1s (D1)
  bool set = false;           // GRC_TEXTURE_DELIVERY was present and non-empty
};

// Parses GRC_TEXTURE_DELIVERY (may be null). On a bad value returns false with *error naming the
// variable and its accepted values, and leaves *out default.
bool parse_delivery_policy(const char *mode, DeliveryPolicy *out, std::string *error);

// The policy a stream runs under (set once at stream start; default rgba).
void texture_delivery_set_policy(const DeliveryPolicy &policy);
DeliveryPolicy texture_delivery_policy();

// Whether this build can honour the mode at /9: rgba, passthrough and basis-uastc (G8ku);
// basis-etc1s is refused typed (`texture-delivery-unimplemented: ...`) until G8ke.
bool delivery_mode_implemented(const DeliveryPolicy &policy, std::string *error);

// Whether the mode offers a `block` variant (D1: passthrough and basis-uastc).
bool mode_offers_block(const std::string &mode);

// Set once at arm by the main thread (a /9 stream whose mode offers `block`), read by the texture
// hooks on any thread (loader threads, G8kw's workers): only then is a block payload built.
void texture_delivery_set_block(bool enabled);
bool texture_delivery_block_enabled();

// The gpu_formats family a block format belongs to (texture-delivery-design.md Q3, D3; Godot's
// feature names): "s3tc" for DXT1/DXT3/DXT5, "bptc" for BPTC_RGBA, "rgtc" for RGTC_R/RGTC_RG,
// "etc2" for ETC and the unswizzled ETC2 family, "astc" for ASTC_4x4/ASTC_8x8. nullptr for every
// other format, including the ones render-stream-9.md never offers as a variant (the
// `*_RA_AS_RG` swizzles, BPTC_RGBF/RGBFU and the ASTC HDR formats).
const char *block_format_family(const std::string &format);

// Godot's data size for a block format's shape (render-stream-9.md "Texture payload",
// `Image::get_image_data_size`): per level, ceil(w/block)*block * ceil(h/block)*block bytes,
// shifted right by the format's shift; -1 for a format block_format_family() refuses or a
// non-positive size.
std::int64_t block_data_bytes(const std::string &format, std::int64_t width, std::int64_t height,
                              bool mipmaps);

// The block variant a texture hook built (empty hash: none).
struct BlockVariant {
  std::string hash;           // SHA-256 of the whole GRT1 payload
  std::string format;         // the source block format's name
  std::uint64_t payload_bytes = 0;
};

// Totals since arm, for result.json's `stream.gate8.delivery_stats` (Q3 "Fallbacks, all typed
// and counted"): block payloads built, their bytes, and block-format sources that got none
// (a family refused, or a size that is not Godot's for the shape).
struct DeliveryStats {
  std::int64_t block_built = 0;
  std::int64_t block_bytes = 0;
  std::int64_t block_declined = 0;
};
void texture_delivery_note_block(bool built, std::uint64_t payload_bytes);
DeliveryStats texture_delivery_stats();

// The session's `resources.texture_delivery` (mode and encoder) for the policy. The encoder is
// null until a Basis encoder exists (G8ku). entry.cpp keeps it in the ResourcePolicy, so the file
// sinks' sessions (Publisher::start) and the live template both declare it.
rs2::TextureDeliveryDeclaration declare_texture_delivery(const DeliveryPolicy &policy);

// --- G8ku: basis-uastc (D6, D11, D12, D13) ---------------------------------------------------

// The encoder a basis-uastc session declares and the default UASTC level; rs_texture_basis.cpp
// static_asserts both against rs_basis_encode.h (this file links no basisu, so the policy tests
// need none).
constexpr const char *kBasisEncoderName = "basisu-1.60";
constexpr int kDefaultUastcLevel = 1;

// The Basis knobs, parsed once at stream start under a /9 basis-uastc stream.
struct BasisConfig {
  int uastc_level = kDefaultUastcLevel;  // GRC_TEXTURE_UASTC_LEVEL 0..4
  std::int64_t min_px = 16384;   // GRC_TEXTURE_BASIS_MIN_PX (D12(c), default 128x128)
  int encode_workers = 2;        // GRC_TEXTURE_ENCODE_WORKERS 1..16 (the encode pool)
  // GRC_TEXTURE_ENCODE_WAIT_FRAME (a test knob, default 0 = off): finished encodes are attached
  // only at that frame's publish, which first waits for every encode queued so far (the main thread
  // waits; it never encodes), so a recording's lazy variants appear at one known frame.
  std::uint64_t wait_frame = 0;
  // GRC_TEXTURE_ENCODE_FAULT=perturb-ktx2 (the sabotage leg's fault knob, never on the wire): one
  // byte of each KTX2 payload is flipped after it was hashed, so a receiver must refuse it.
  bool fault_perturb = false;
  // GRC_TEXTURE_ENCODE_FAULT=corrupt-ktx2 (G8kf, likewise): level 0's compressed bytes are damaged
  // BEFORE hashing, so every check passes but the receiver's transcode fails (Q3's fallback).
  bool fault_corrupt = false;
  // GRC_TEXTURE_ENCODE_DRAIN=1 (G8kf, the prepare step): the stream's end waits for every queued
  // encode instead of dropping it (so each one reaches the persisted cache), and the frame
  // callback keeps the queue short (2 jobs per worker) so a long pack never holds more than a few
  // decoded payloads beside the mirror.
  bool drain = false;
};

// Each argument is the raw environment value or nullptr. False with `error` set on a bad value.
bool parse_basis_config(const char *level, const char *min_px, const char *workers,
                        const char *wait_frame, const char *fault, BasisConfig *out,
                        std::string *error, const char *drain = nullptr);

// Set once at stream start (a /9 basis-uastc stream), read by the mirror and the encode jobs.
void texture_delivery_set_basis(bool enabled, const BasisConfig &config);
bool texture_delivery_basis_enabled();
BasisConfig texture_delivery_basis_config();

// D12 for one ok image entry: nullptr when a Basis variant may be offered, else the decline
// reason: "updated" (D12(a): texture_2d_update'd, which covers glyph atlases and every in-place
// update), "format" (D12(b): the payload is not RGBA8 or RGB8; a block source counts by its
// decoded payload) or "small" (D12(c): fewer than min_px texels).
const char *basis_decline_reason(const std::string &format, std::int64_t width,
                                 std::int64_t height, bool updated, std::int64_t min_px);

// The mip levels of a GRT1 payload of `format` (RGBA8 or RGB8), as straight RGBA8 (RGB8 gains
// alpha 255), level 0 first, each max(1, w >> i) x max(1, h >> i). False on a payload whose
// header or size disagrees.
bool grt1_rgba8_levels(const std::vector<std::uint8_t> &grt1, const std::string &format,
                       std::int64_t width, std::int64_t height, bool mipmaps,
                       std::vector<std::vector<std::uint8_t>> *levels);

// One lazy encode (D6): the entry's decoded payload at the version it was taken from. Header-only:
// the mirror creates it, the encode pool (rs_texture_basis.h) finishes it exactly once.
class BasisJob {
 public:
  // `cache_source`: the entry's D7 source key (G8kc, PayloadCopy::source_key), empty when the
  // persisted cache is closed; the job then always encodes.
  BasisJob(std::uint32_t id, std::uint64_t version, std::string source_hash,
           std::shared_ptr<const std::vector<std::uint8_t>> source, std::string format,
           std::int64_t width, std::int64_t height, bool mipmaps, std::string cache_source = "")
      : id_(id), version_(version), source_hash_(std::move(source_hash)),
        source_(std::move(source)), format_(std::move(format)), width_(width), height_(height),
        mipmaps_(mipmaps), cache_source_(std::move(cache_source)) {}

  struct Outcome {
    bool ok = false;
    std::string error;
    std::string hash;    // SHA-256 of the KTX2 bytes (before any fault)
    std::string params;  // the encoder's params_id
    std::shared_ptr<const std::vector<std::uint8_t>> ktx2;
    std::uint64_t encode_ns = 0;
    std::uint64_t hash_ns = 0;
    // G8kc's cache (D8): "hit" (served from a verified file, no encode), "miss" or "corrupt"
    // (encoded, then stored), "" when the cache is closed (encoded).
    std::string cache;
  };

  void finish(Outcome outcome) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      outcome_ = std::move(outcome);
      source_.reset();  // the job no longer pins the decoded payload
      done_.store(true, std::memory_order_release);
    }
    cv_.notify_all();
  }
  bool done() const { return done_.load(std::memory_order_acquire); }
  void wait() const {
    std::unique_lock<std::mutex> lock(mutex_);
    cv_.wait(lock, [this] { return done_.load(std::memory_order_acquire); });
  }
  // Marks the job abandoned (the stream ended before a worker took it): wait() returns.
  void abandon() {
    Outcome out;
    out.error = "abandoned";
    finish(std::move(out));
  }

  std::uint32_t id() const { return id_; }
  std::uint64_t version() const { return version_; }
  const std::string &source_hash() const { return source_hash_; }
  std::shared_ptr<const std::vector<std::uint8_t>> source() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return source_;
  }
  const std::string &format() const { return format_; }
  std::int64_t width() const { return width_; }
  std::int64_t height() const { return height_; }
  bool mipmaps() const { return mipmaps_; }
  const std::string &cache_source() const { return cache_source_; }
  const Outcome &outcome() const { return outcome_; }  // valid once done()

 private:
  std::uint32_t id_;
  std::uint64_t version_;
  std::string source_hash_;
  std::shared_ptr<const std::vector<std::uint8_t>> source_;
  std::string format_;
  std::int64_t width_;
  std::int64_t height_;
  bool mipmaps_;
  std::string cache_source_;
  mutable std::mutex mutex_;
  mutable std::condition_variable cv_;
  std::atomic<bool> done_{false};
  Outcome outcome_;
};
using BasisJobPtr = std::shared_ptr<BasisJob>;

// Basis totals since arm, for `stream.gate8.delivery_stats` (Q3 "all typed and counted").
struct BasisStats {
  std::int64_t uastc_built = 0;        // variants attached to an entry
  std::int64_t uastc_bytes = 0;
  std::int64_t uastc_failed = 0;       // encoder refusals or failures (no variant)
  std::int64_t uastc_stale = 0;        // finished after the content changed (discarded)
  std::int64_t declined_updated = 0;   // D12(a)
  std::int64_t declined_format = 0;    // D12(b)
  std::int64_t declined_small = 0;     // D12(c)
  std::int64_t encodes_submitted = 0;
  std::int64_t encodes_run = 0;        // basisu encodes actually run, attached or not (G8kc's
                                       // texture_cache.encodes)
  std::int64_t cache_hits = 0;         // attached variants served from the persisted cache
  std::uint64_t encode_ns_total = 0;
  std::uint64_t encode_ns_max = 0;
  std::uint64_t encode_px_total = 0;   // level-0 texels encoded (for ms per Mpx)
};
void texture_delivery_note_basis_decline(const char *reason);
void texture_delivery_note_basis_submit();
// Every basisu encode actually run (on an encode worker), whether or not its result is attached.
void texture_delivery_note_encode_run();
void texture_delivery_note_basis_result(bool attached, bool stale, const BasisJob &job);
BasisStats texture_delivery_basis_stats();

// What the seam is asked about one ok image texture entry.
struct VariantRequest {
  std::uint32_t id = 0;
  std::string hash;    // the `decoded` payload's hash
  std::string format;  // the `decoded` payload's format name
  std::int32_t width = 0;
  std::int32_t height = 0;
  bool mipmaps = false;
  std::uint64_t version = 1;  // the entry's content version (D6)
  BlockVariant block;         // G8kp: the hooked bytes as a block GRT1 (empty hash: none)
  // G8ku: the finished lazy encode of this version's decoded payload (empty hash: none yet).
  std::string uastc_hash;
  std::uint64_t uastc_payload_bytes = 0;
  std::string uastc_params;
};

// The variants the host has ready for this entry, sorted by encoding (block, uastc, etc1s), at
// most one each: under a mode offering `block`, the request's block variant when it has one
// (G8kp); under basis-uastc, the request's uastc variant when its encode finished (G8ku). Never a variant whose hash is the entry's own (render-stream-9.md invariant 4).
std::vector<rs2::TextureVariant> texture_variants(const VariantRequest &request);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TEXTURE_DELIVERY_H
