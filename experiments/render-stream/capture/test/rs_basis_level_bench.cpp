// G8ku: UASTC pack level against speed and PSNR (results/gate8/g8ku.md "UASTC level").
//
//   rs_basis_level_bench <manifest.tsv> [levels, default 0,1,2] [reps, default 1]
//
// Each manifest line is `name<TAB>width<TAB>height<TAB>path`, the path a raw straight RGBA8 file
// (width*height*4 bytes; scripts/test/g8ku-png-to-rgba.gd writes them from PNGs outside the
// repository). Each image is encoded as one level, single-threaded (the capture's encode workers
// are single-threaded too), at each level, `reps` times (the minimum is reported); the KTX2 is
// transcoded back to RGBA8 by basisu's own transcoder (Godot 4.5.1's revision) and PSNR is taken
// against the source over RGBA and over RGB. Transcode times to BC7 and ASTC 4x4 (the D14 targets
// of a desktop and a phone receiver, native code) are printed too. Prints one TSV row per image and
// level; no game content is ever written.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "rs_basis_encode.h"
#include "transcoder/basisu_transcoder.h"

namespace {

double now_ms() {
	return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

double psnr(const std::vector<uint8_t> &a, const std::vector<uint8_t> &b, bool alpha) {
	double se = 0;
	size_t n = 0;
	for (size_t i = 0; i < a.size(); i++) {
		if (!alpha && i % 4 == 3) continue;
		const double d = double(a[i]) - double(b[i]);
		se += d * d;
		n++;
	}
	if (se == 0) return 99.0;
	return 10.0 * std::log10(255.0 * 255.0 / (se / double(n)));
}

double transcode_ms(const std::vector<uint8_t> &ktx2, basist::transcoder_texture_format fmt) {
	basist::ktx2_transcoder t;
	if (!t.init(ktx2.data(), uint32_t(ktx2.size())) || !t.start_transcoding()) return -1;
	basist::ktx2_image_level_info info;
	t.get_image_level_info(info, 0, 0, 0);
	std::vector<uint8_t> out(size_t(info.m_total_blocks) * 16);
	const double t0 = now_ms();
	if (!t.transcode_image_level(0, 0, 0, out.data(), info.m_total_blocks, fmt)) return -1;
	return now_ms() - t0;
}

} // namespace

int main(int argc, char **argv) {
	if (argc < 2) {
		std::fprintf(stderr, "usage: rs_basis_level_bench <manifest.tsv> [levels] [reps]\n");
		return 2;
	}
	std::vector<int> levels = {0, 1, 2};
	if (argc > 2) {
		levels.clear();
		std::stringstream ss(argv[2]);
		std::string tok;
		while (std::getline(ss, tok, ',')) levels.push_back(std::atoi(tok.c_str()));
	}
	const int reps = argc > 3 ? std::max(1, std::atoi(argv[3])) : 1;
	rs::basis::init();
	std::ifstream man(argv[1]);
	std::string line;
	std::printf("name\twidth\theight\tmpx\talpha\tlevel\tencode_ms\tms_per_mpx\tktx2_bytes\tbytes_per_px\tpsnr_rgba\tpsnr_rgb\tto_bc7_ms\tto_astc_ms\n");
	while (std::getline(man, line)) {
		if (line.empty()) continue;
		std::stringstream ls(line);
		std::string name, ws, hs, path;
		std::getline(ls, name, '\t');
		std::getline(ls, ws, '\t');
		std::getline(ls, hs, '\t');
		std::getline(ls, path, '\t');
		const uint32_t w = uint32_t(std::atoi(ws.c_str())), h = uint32_t(std::atoi(hs.c_str()));
		std::ifstream f(path, std::ios::binary);
		std::vector<uint8_t> px((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
		if (px.size() != size_t(w) * h * 4) {
			std::fprintf(stderr, "%s: %zu bytes, expected %u x %u x 4\n", name.c_str(), px.size(), w, h);
			return 1;
		}
		bool alpha = false;
		for (size_t i = 3; i < px.size() && !alpha; i += 4) alpha = px[i] != 255;
		const double mpx = double(w) * h / 1e6;
		for (const int level : levels) {
			const rs::basis::Level l{w, h, px.data()};
			double best = 1e30;
			rs::basis::EncodeResult r;
			for (int i = 0; i < reps; i++) {
				const double t0 = now_ms();
				r = rs::basis::encode_uastc_ktx2(&l, 1, level);
				best = std::min(best, now_ms() - t0);
			}
			if (!r.ok) {
				std::fprintf(stderr, "%s level %d: %s\n", name.c_str(), level, r.error.c_str());
				return 1;
			}
			std::vector<uint8_t> back;
			uint32_t bw = 0, bh = 0;
			if (!rs::basis::transcode_rgba8(r.ktx2, 0, &back, &bw, &bh) || bw != w || bh != h) {
				std::fprintf(stderr, "%s level %d: transcode failed\n", name.c_str(), level);
				return 1;
			}
			std::printf("%s\t%u\t%u\t%.3f\t%d\t%d\t%.1f\t%.0f\t%zu\t%.3f\t%.2f\t%.2f\t%.2f\t%.2f\n", name.c_str(), w, h, mpx,
					alpha ? 1 : 0, level, best, best / mpx, r.ktx2.size(), double(r.ktx2.size()) / (double(w) * h),
					psnr(px, back, true), psnr(px, back, false),
					transcode_ms(r.ktx2, basist::transcoder_texture_format::cTFBC7_RGBA),
					transcode_ms(r.ktx2, basist::transcoder_texture_format::cTFASTC_4x4_RGBA));
			std::fflush(stdout);
		}
	}
	return 0;
}
