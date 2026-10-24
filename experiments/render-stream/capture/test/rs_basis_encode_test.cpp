// G8kv: rs_basis_encode on synthetic procedural images (no game content).
//   rs_basis_encode_test              encode, validate the KTX2 against render-stream-9.md's `ktx2`
//                                     profile, thread-safety and determinism, input refusals
//   rs_basis_encode_test --emit DIR   also write DIR/<case>.ktx2, DIR/<case>.<level>.rgba and
//                                     DIR/manifest.tsv for the Godot-transcoder round trip
//                                     (scripts/test/g8kv-roundtrip.sh)
//   rs_basis_encode_test --bench      print the single-thread encode time per Mpx
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "rs_basis_encode.h"

namespace {

int g_fail = 0;
#define CHECK(cond, ...)                                           \
	do {                                                           \
		if (!(cond)) {                                             \
			std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
			std::fprintf(stderr, __VA_ARGS__);                     \
			std::fprintf(stderr, "\n");                            \
			g_fail++;                                              \
		}                                                          \
	} while (0)

struct Img {
	uint32_t w = 0, h = 0;
	std::vector<uint8_t> px;
};

uint32_t lcg(uint32_t &s) {
	s = s * 1664525u + 1013904223u;
	return s >> 8;
}

// kind 0: smooth gradient + rings (UI-like); 1: noise over a gradient (hard); 2: alpha sprite.
Img make(uint32_t w, uint32_t h, int kind) {
	Img im{w, h, std::vector<uint8_t>(size_t(w) * h * 4)};
	uint32_t seed = 12345u + uint32_t(kind);
	for (uint32_t y = 0; y < h; y++) {
		for (uint32_t x = 0; x < w; x++) {
			uint8_t *p = &im.px[(size_t(y) * w + x) * 4];
			const double fx = double(x) / std::max(1u, w - 1), fy = double(y) / std::max(1u, h - 1);
			const double r = std::hypot(fx - 0.5, fy - 0.5);
			// Colours lie near one line in RGB (a luminance ramp with a tint), as UI art and photos mostly
			// do; independent R and G ramps in one 4x4 block would be a worst case for any 4x4 codec.
			const double t = 0.5 * (fx + fy), ring = 30 * std::sin(r * 12.0);
			double R = 40 + 180 * t + ring, G = 60 + 150 * t + ring, B = 100 + 100 * t + ring, A = 255;
			if (kind == 1) {
				R += double(lcg(seed) % 41) - 20;
				G += double(lcg(seed) % 41) - 20;
				B += double(lcg(seed) % 41) - 20;
			} else if (kind == 2) {
				A = r < 0.4 ? 255 * (1.0 - r / 0.4 * 0.5) : (r < 0.45 ? 128 : 0);
				if (A == 0) R = G = B = 0;
			}
			auto cl = [](double v) { return uint8_t(v < 0 ? 0 : v > 255 ? 255 : v + 0.5); };
			p[0] = cl(R); p[1] = cl(G); p[2] = cl(B); p[3] = cl(A);
		}
	}
	return im;
}

Img half(const Img &s) {
	Img d{std::max(1u, s.w >> 1), std::max(1u, s.h >> 1), {}};
	d.px.resize(size_t(d.w) * d.h * 4);
	for (uint32_t y = 0; y < d.h; y++)
		for (uint32_t x = 0; x < d.w; x++)
			for (int c = 0; c < 4; c++) {
				int sum = 0, n = 0;
				for (uint32_t dy = 0; dy < 2; dy++)
					for (uint32_t dx = 0; dx < 2; dx++) {
						const uint32_t sx = std::min(s.w - 1, x * 2 + dx), sy = std::min(s.h - 1, y * 2 + dy);
						sum += s.px[(size_t(sy) * s.w + sx) * 4 + c];
						n++;
					}
				d.px[(size_t(y) * d.w + x) * 4 + c] = uint8_t((sum + n / 2) / n);
			}
	return d;
}

std::vector<Img> chain(const Img &base, bool mips) {
	std::vector<Img> v{base};
	while (mips && (v.back().w > 1 || v.back().h > 1)) v.push_back(half(v.back()));
	return v;
}

rs::basis::EncodeResult encode(const std::vector<Img> &levels) {
	std::vector<rs::basis::Level> l;
	for (const Img &i : levels) l.push_back({i.w, i.h, i.px.data()});
	return rs::basis::encode_uastc_ktx2(l.data(), l.size());
}

uint32_t rd32(const std::vector<uint8_t> &b, size_t o) {
	return uint32_t(b[o]) | uint32_t(b[o + 1]) << 8 | uint32_t(b[o + 2]) << 16 | uint32_t(b[o + 3]) << 24;
}
uint64_t rd64(const std::vector<uint8_t> &b, size_t o) { return rd32(b, o) | uint64_t(rd32(b, o + 4)) << 32; }

// The `ktx2-header` rules of render-stream-9.md, plus `ktx2-shape` against the source chain.
void validate(const std::string &name, const std::vector<uint8_t> &b, const std::vector<Img> &src) {
	static const uint8_t id[12] = {0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A};
	CHECK(b.size() >= 80 && std::memcmp(b.data(), id, 12) == 0, "%s: identifier", name.c_str());
	if (b.size() < 80) return;
	const uint32_t levels = rd32(b, 40);
	CHECK(rd32(b, 12) == 0, "%s: vkFormat %u", name.c_str(), rd32(b, 12));
	CHECK(rd32(b, 16) == 1, "%s: typeSize", name.c_str());
	CHECK(rd32(b, 20) == src[0].w && rd32(b, 24) == src[0].h, "%s: size %ux%u", name.c_str(), rd32(b, 20), rd32(b, 24));
	CHECK(rd32(b, 28) == 0 && rd32(b, 32) == 0 && rd32(b, 36) == 1, "%s: depth/layers/faces", name.c_str());
	CHECK(levels == src.size(), "%s: levelCount %u vs %zu", name.c_str(), levels, src.size());
	CHECK(rd32(b, 44) == 2, "%s: supercompressionScheme %u (want 2 Zstandard)", name.c_str(), rd32(b, 44));
	const uint32_t dfdOff = rd32(b, 48), dfdLen = rd32(b, 52);
	CHECK(uint64_t(dfdOff) + dfdLen <= b.size() && dfdLen >= 28, "%s: DFD inside file", name.c_str());
	const uint32_t kvOff = rd32(b, 56), kvLen = rd32(b, 60);
	CHECK(uint64_t(kvOff) + kvLen <= b.size(), "%s: key/value inside file", name.c_str());
	CHECK(rd64(b, 72) == 0 || rd32(b, 44) != 1, "%s: no BasisLZ global data", name.c_str());
	if (uint64_t(dfdOff) + dfdLen <= b.size() && dfdLen >= 28) {
		CHECK(rd32(b, dfdOff) == dfdLen, "%s: DFD total size", name.c_str());
		const uint32_t w1 = rd32(b, dfdOff + 4), w2 = rd32(b, dfdOff + 8), w3 = rd32(b, dfdOff + 12);
		CHECK((w1 & 0x1ffff) == 0, "%s: vendor/type", name.c_str());
		CHECK((w2 & 0xffff) == 2 && (w2 >> 16) == dfdLen - 4, "%s: version %u block size %u", name.c_str(), w2 & 0xffff, w2 >> 16);
		CHECK((w3 & 0xff) == 166, "%s: colour model %u (UASTC=166)", name.c_str(), w3 & 0xff);
		CHECK(((w3 >> 16) & 0xff) == 1, "%s: transfer %u (linear=1)", name.c_str(), (w3 >> 16) & 0xff);
		const uint32_t w4 = rd32(b, dfdOff + 16);
		CHECK((w4 & 0xff) == 3 && ((w4 >> 8) & 0xff) == 3 && ((w4 >> 16) & 0xff) == 0, "%s: 4x4x1 texel block", name.c_str());
	}
	for (uint32_t i = 0; i < levels && 80 + 24 * (i + 1) <= b.size() && i < src.size(); i++) {
		const uint64_t off = rd64(b, 80 + 24 * i), len = rd64(b, 88 + 24 * i), ulen = rd64(b, 96 + 24 * i);
		CHECK(len >= 1 && off + len <= b.size(), "%s: level %u range", name.c_str(), i);
		const uint64_t want = uint64_t((src[i].w + 3) / 4) * ((src[i].h + 3) / 4) * 16;
		CHECK(ulen == want, "%s: level %u uncompressedByteLength %llu vs %llu", name.c_str(), i,
				(unsigned long long)ulen, (unsigned long long)want);
	}
}

struct Case {
	const char *name;
	uint32_t w, h;
	int kind;
	bool mips;
	int floor_db; // smoke floor for the Godot round trip's per-level PSNR (stress cases are lower)
};
const Case kCases[] = {
	{"smooth64x48", 64, 48, 0, true, 36},
	{"noise64x64", 64, 64, 1, true, 30},
	{"sprite37x21", 37, 21, 2, true, 28},
	{"one1x1", 1, 1, 0, false, 40},
	{"tall4x130", 4, 130, 2, true, 28},
	{"smooth256x256", 256, 256, 0, true, 36},
};

} // namespace

int main(int argc, char **argv) {
	std::string emit;
	bool bench = false;
	for (int i = 1; i < argc; i++) {
		if (!std::strcmp(argv[i], "--emit") && i + 1 < argc) emit = argv[++i];
		else if (!std::strcmp(argv[i], "--bench")) bench = true;
	}
	CHECK(std::string(rs::basis::params_id(2)) == "basisu-1.60/uastc-l2/zstd6/linear", "params_id");
	CHECK(rs::basis::params_id(5) == nullptr && rs::basis::params_id(-1) == nullptr, "params_id range");

	// Input refusals never throw and never encode.
	{
		Img a = make(8, 8, 0);
		rs::basis::Level bad[2] = {{8, 8, a.px.data()}, {3, 4, a.px.data()}};
		CHECK(!rs::basis::encode_uastc_ktx2(bad, 2).ok, "wrong level size refused");
		CHECK(!rs::basis::encode_uastc_ktx2(bad, 0).ok, "zero levels refused");
		CHECK(!rs::basis::encode_uastc_ktx2(nullptr, 1).ok, "null refused");
		rs::basis::Level nopix[1] = {{8, 8, nullptr}};
		CHECK(!rs::basis::encode_uastc_ktx2(nopix, 1).ok, "null pixels refused");
	}

	std::vector<std::vector<uint8_t>> single;
	std::vector<std::vector<Img>> chains;
	FILE *man = nullptr;
	if (!emit.empty()) man = std::fopen((emit + "/manifest.tsv").c_str(), "w");
	for (const Case &c : kCases) {
		chains.push_back(chain(make(c.w, c.h, c.kind), c.mips));
		const auto t0 = std::chrono::steady_clock::now();
		const auto r = encode(chains.back());
		const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
		CHECK(r.ok, "%s: %s", c.name, r.error.c_str());
		single.push_back(r.ktx2);
		std::printf("%-14s %ux%u levels=%zu ktx2=%zu bytes encode=%.1f ms\n", c.name, c.w, c.h, chains.back().size(), r.ktx2.size(), ms);
		if (!r.ok) continue;
		validate(c.name, r.ktx2, chains.back());
		if (man) {
			FILE *f = std::fopen((emit + "/" + c.name + ".ktx2").c_str(), "wb");
			std::fwrite(r.ktx2.data(), 1, r.ktx2.size(), f);
			std::fclose(f);
			for (size_t i = 0; i < chains.back().size(); i++) {
				f = std::fopen((emit + "/" + c.name + "." + std::to_string(i) + ".rgba").c_str(), "wb");
				std::fwrite(chains.back()[i].px.data(), 1, chains.back()[i].px.size(), f);
				std::fclose(f);
			}
			std::fprintf(man, "%s\t%u\t%u\t%zu\t%d\n", c.name, c.w, c.h, chains.back().size(), c.floor_db);
		}
	}
	if (man) std::fclose(man);

	// Thread safety: init races on the first call in a real worker pool, so encode concurrently
	// and require byte-identical files (the encode is deterministic on one thread).
	{
		std::vector<std::thread> ts;
		std::vector<int> bad(6, 0);
		for (int t = 0; t < 6; t++)
			ts.emplace_back([&, t] {
				for (size_t i = 0; i < chains.size(); i++) {
					const size_t k = (i + size_t(t)) % chains.size();
					if (encode(chains[k]).ktx2 != single[k]) bad[t]++;
				}
			});
		for (auto &t : ts) t.join();
		for (int t = 0; t < 6; t++) CHECK(bad[t] == 0, "thread %d: %d concurrent encodes differ from the single-thread file", t, bad[t]);
	}

	if (bench) {
		for (int kind = 0; kind < 3; kind++) {
			const Img big = make(1024, 1024, kind);
			const auto t0 = std::chrono::steady_clock::now();
			const auto r = encode({big});
			const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
			std::printf("bench kind=%d 1024x1024 level0 only: %.0f ms = %.0f ms/Mpx, %zu bytes (%.2f%% of RGBA8)\n", kind, ms,
					ms / (1024.0 * 1024.0 / 1e6), r.ktx2.size(), 100.0 * r.ktx2.size() / (1024.0 * 1024 * 4));
		}
	}
	std::printf(g_fail ? "FAILED %d\n" : "ok\n", g_fail);
	return g_fail ? 1 : 0;
}
