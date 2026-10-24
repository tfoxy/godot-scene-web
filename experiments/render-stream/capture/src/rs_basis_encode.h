// G8kv: the Basis Universal host encoder wrapper (texture-delivery-design.md D13, D15).
//
// RGBA8 mip levels in, one KTX2 file out: UASTC LDR 4x4 (level 0-4, default 1, no RDO) with Zstandard level 6
// supercompression, `vkFormat` 0, a LINEAR DFD transfer, the levels given explicitly (basisu's
// `m_mip_gen` is never used, so every level is the caller's, byte for byte, before quantization).
// The result is a `render-stream-texture/ktx2` payload (render-stream-9.md "KTX2 payload").
//
// G8ku calls it from the encode pool (rs_texture_delivery.h). This header includes no basisu header, so a TU
// that only encodes does not see the third-party defines.
//
// Thread safety: `encode_uastc_ktx2` may be called concurrently from any number of threads. The
// one-time `basisu::basisu_encoder_init()` (global tables, CPU feature probes) runs under
// `std::call_once`, on the first call or on an explicit `init()`; every call after it only reads
// those tables. Each call encodes single-threaded on its caller's thread (the worker pool of G8kw
// is the parallelism), with its own compressor and job pool, and prints nothing.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace rs::basis {

// One mip level: `rgba` is width*height*4 bytes, row-major, straight (non-premultiplied) RGBA8.
struct Level {
	uint32_t width = 0;
	uint32_t height = 0;
	const uint8_t *rgba = nullptr;
};

struct EncodeResult {
	bool ok = false;
	std::string error;
	std::vector<uint8_t> ktx2;
	std::string params_id; // what produced `ktx2`; equals params_id()
};

// The UASTC pack level (basisu cPackUASTCLevelFastest 0 .. VerySlow 4). G8ku measured 0-2 for
// speed against PSNR (results/gate8/g8ku.md "UASTC level") and chose the default below; the
// capture's GRC_TEXTURE_UASTC_LEVEL overrides it per session.
constexpr int kMinUastcLevel = 0;
constexpr int kMaxUastcLevel = 4;
constexpr int kDefaultUastcLevel = 1;

// The encoder revision and settings as a string, e.g. "basisu-1.60/uastc-l1/zstd6/linear": every
// setting that changes bytes, the level included. It goes into a variant's `params`
// (render-stream-9.md) and into any cache key (D7). nullptr for a level outside 0..4.
const char *params_id(int uastc_level = kDefaultUastcLevel);

// The encoder name a /9 session declares (`resources.texture_delivery.encoder`): every params_id
// starts with it and a '/'.
const char *encoder_name();

// Idempotent and thread-safe; encode_uastc_ktx2 calls it itself.
void init();

// Level 0 first; level i must be max(1, w0 >> i) x max(1, h0 >> i) (the KTX2 level rule), and
// 1 to 32 levels. A failure sets ok=false and `error` and never throws.
EncodeResult encode_uastc_ktx2(const Level *levels, size_t level_count,
                               int uastc_level = kDefaultUastcLevel);

// basisu's own transcoder (the revision Godot 4.5.1 links): level `level` of a UASTC or ETC1S KTX2
// to straight RGBA8, for host-side PSNR and the level bench. False on anything malformed.
bool transcode_rgba8(const std::vector<uint8_t> &ktx2, uint32_t level, std::vector<uint8_t> *rgba,
                     uint32_t *width, uint32_t *height);

} // namespace rs::basis
