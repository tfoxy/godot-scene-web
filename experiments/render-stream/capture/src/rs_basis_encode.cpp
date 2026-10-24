#include "rs_basis_encode.h"

#include <algorithm>
#include <mutex>

#include "encoder/basisu_comp.h"
#include "transcoder/basisu_transcoder.h"

namespace rs::basis {

namespace {
constexpr int kZstdLevel = 6;
std::once_flag g_init_once;
constexpr const char *kParams[] = {
		"basisu-1.60/uastc-l0/zstd6/linear", "basisu-1.60/uastc-l1/zstd6/linear",
		"basisu-1.60/uastc-l2/zstd6/linear", "basisu-1.60/uastc-l3/zstd6/linear",
		"basisu-1.60/uastc-l4/zstd6/linear"};
} // namespace

const char *params_id(int uastc_level) {
	if (uastc_level < kMinUastcLevel || uastc_level > kMaxUastcLevel) return nullptr;
	return kParams[uastc_level];
}

const char *encoder_name() { return "basisu-1.60"; }

void init() {
	// basisu_encoder_init also runs basisu_transcoder_init (transcode_rgba8 relies on it).
	std::call_once(g_init_once, [] { basisu::basisu_encoder_init(false, false); });
}

bool transcode_rgba8(const std::vector<uint8_t> &ktx2, uint32_t level, std::vector<uint8_t> *rgba,
		uint32_t *width, uint32_t *height) {
	init();
	try {
		basist::ktx2_transcoder t;
		if (ktx2.empty() || !t.init(ktx2.data(), uint32_t(ktx2.size())) || level >= t.get_levels() || !t.start_transcoding()) {
			return false;
		}
		basist::ktx2_image_level_info info;
		if (!t.get_image_level_info(info, level, 0, 0)) return false;
		rgba->assign(size_t(info.m_orig_width) * info.m_orig_height * 4, 0);
		*width = info.m_orig_width;
		*height = info.m_orig_height;
		return t.transcode_image_level(level, 0, 0, rgba->data(), info.m_orig_width * info.m_orig_height,
				basist::transcoder_texture_format::cTFRGBA32);
	} catch (const std::exception &) {
		return false;
	}
}

EncodeResult encode_uastc_ktx2(const Level *levels, size_t level_count, int uastc_level) {
	EncodeResult out;
	if (params_id(uastc_level) == nullptr) {
		out.error = "uastc level must be 0..4";
		return out;
	}
	out.params_id = params_id(uastc_level);
	if (levels == nullptr || level_count < 1 || level_count > 32) {
		out.error = "level count must be 1..32";
		return out;
	}
	for (size_t i = 0; i < level_count; i++) {
		const uint32_t w = std::max<uint32_t>(1, levels[0].width >> i);
		const uint32_t h = std::max<uint32_t>(1, levels[0].height >> i);
		if (levels[0].width == 0 || levels[0].height == 0 || levels[i].width != w || levels[i].height != h) {
			out.error = "level " + std::to_string(i) + " is not max(1, base >> level) in each dimension";
			return out;
		}
		if (levels[i].rgba == nullptr) {
			out.error = "level " + std::to_string(i) + " has no pixels";
			return out;
		}
	}
	init();
	try {
		basisu::basis_compressor_params p;
		auto to_image = [](const Level &l) {
			basisu::image img(l.width, l.height);
			std::copy(l.rgba, l.rgba + size_t(l.width) * l.height * 4, reinterpret_cast<uint8_t *>(img.get_ptr()));
			return img;
		};
		p.m_source_images.push_back(to_image(levels[0]));
		if (level_count > 1) {
			p.m_source_mipmap_images.resize(1);
			for (size_t i = 1; i < level_count; i++) {
				p.m_source_mipmap_images[0].push_back(to_image(levels[i]));
			}
		}
		p.m_uastc = true;
		p.m_pack_uastc_ldr_4x4_flags &= ~basisu::cPackUASTCLevelMask;
		p.m_pack_uastc_ldr_4x4_flags |= uint32_t(uastc_level);
		p.m_rdo_uastc_ldr_4x4 = false;
		p.m_create_ktx2_file = true;
		p.m_ktx2_uastc_supercompression = basist::KTX2_SS_ZSTANDARD;
		p.m_ktx2_zstd_supercompression_level = kZstdLevel;
		p.m_ktx2_srgb_transfer_func = false; // D13: Godot 2D textures carry raw values
		p.m_perceptual = false;
		p.m_mip_gen = false;
		// Alpha is decided here, over every level, not by basisu's own check (which looks at the
		// first image only): a texture with any alpha < 255 is encoded with alpha (UASTC carries
		// it), an opaque one without, which is also what Godot's packer does for an RGB image.
		bool has_alpha = false;
		for (size_t i = 0; i < level_count && !has_alpha; i++) {
			const size_t n = size_t(levels[i].width) * levels[i].height;
			for (size_t px = 0; px < n; px++) {
				if (levels[i].rgba[px * 4 + 3] != 255) {
					has_alpha = true;
					break;
				}
			}
		}
		p.m_check_for_alpha = false;
		p.m_force_alpha = has_alpha;
		p.m_multithreading = false;
		p.m_status_output = false;
		p.m_compute_stats = false;
		p.m_print_stats = false;
		p.m_debug = false;
		basisu::job_pool pool(1);
		p.m_pJob_pool = &pool;
		basisu::basis_compressor c;
		if (!c.init(p)) {
			out.error = "basisu init refused the parameters";
			return out;
		}
		if (c.process() != basisu::basis_compressor::cECSuccess) {
			out.error = "basisu compression failed";
			return out;
		}
		const basisu::uint8_vec &k = c.get_output_ktx2_file();
		out.ktx2.assign(k.begin(), k.end());
		out.ok = !out.ktx2.empty();
		if (!out.ok) out.error = "basisu produced no KTX2 file";
	} catch (const std::exception &e) {
		out.error = std::string("basisu threw: ") + e.what();
	}
	return out;
}

} // namespace rs::basis
