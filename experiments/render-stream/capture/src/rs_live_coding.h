// render-stream/11's live transport coding (W11t; protocol/render-stream-11.md "Transport:
// base-prefix zstd" and "As built (W11t)"): the host half, over the vendored zstd 1.5.7
// (capture/vendor/PROVENANCE.md). The receivers' half is rs-core's `coding` module.
//
// A /11 connection whose hello offered `live_coding` and whose host accepted a coding gets every
// binary message coded, the first (magic + session) included:
//   plain-coded   one zstd frame (level 3, content size, XXH64 checksum), no dictionary: the
//                 session message, every resource record and the end record.
//   transaction   an envelope -- a zstd skippable frame, magic 0x184D2A5B, 16 bytes of content:
//                 u64le seq, u64le base_seq (0: none) -- then one zstd frame. Under zstd-base a
//                 patch's frame has its base transaction's uncoded message as a raw prefix (zstd
//                 refPrefix); a full transaction, and every transaction under plain zstd, has none.
// The coded bytes are a function of the uncoded (base, target) messages alone, so lockstep viewers
// share them (the hub memoizes them per callback, rs_live.h).
//
// Engine-free; the context is thread_local, so concurrent callers never share one.
#ifndef GRC_RS_LIVE_CODING_H
#define GRC_RS_LIVE_CODING_H

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace grc {
namespace rs {
namespace live_coding {

constexpr int kLevel = 3;
constexpr std::uint32_t kEnvelopeMagic = 0x184D2A5Bu;
constexpr std::uint32_t kZstdMagic = 0xFD2FB528u;
constexpr std::size_t kEnvelopeBytes = 24;

enum class Coding : std::uint8_t { Off, Zstd, ZstdBase };

// "off", "zstd" or "zstd-base".
const char *to_token(Coding coding);

// GRC_LIVE_CODING: null or empty -> zstd-base (the default); otherwise off | zstd | zstd-base.
bool parse_env(const char *text, Coding *out, std::string *error);

// The hello's `live_coding` grammar: ^[a-z0-9-]+(,[a-z0-9-]+)*$, at most 96 characters.
bool valid_offer(const std::string &offer);

// The coding a host configured with `host` uses for a receiver that offered `offer` (tokens it
// does not know are ignored): zstd-base needs the receiver to offer zstd-base, and falls back to
// zstd when it offers only that; zstd needs zstd; anything else is off.
Coding negotiate(Coding host, const std::string &offer);

// A plain-coded message: one zstd frame of `data`. False (and *out empty) on failure.
bool encode_plain(const std::uint8_t *data, std::size_t size, std::vector<std::uint8_t> *out);

// A coded transaction: the envelope (seq, base_seq) and one zstd frame of `data`, with `base`
// (base_size bytes, the base transaction's uncoded message) as its raw prefix when base is not
// null. base_seq is written as given (0 for none). False (and *out empty) on failure.
bool encode_transaction(const std::uint8_t *data, std::size_t size, std::uint64_t seq,
                        const std::uint8_t *base, std::size_t base_size, std::uint64_t base_seq,
                        std::vector<std::uint8_t> *out);

// Decodes one coded message (tests, the sabotage's self-check and rs_live_coding_tool): `base`
// is the prefix to use for an enveloped message whose base_seq is not 0. Sets *seq and *base_seq
// (0 for a plain-coded message). False with *error on anything that rs-core would call `coding`.
bool decode(const std::uint8_t *msg, std::size_t size, const std::vector<std::uint8_t> *base,
            std::vector<std::uint8_t> *out, std::uint64_t *seq, std::uint64_t *base_seq,
            std::string *error);

}  // namespace live_coding
}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_LIVE_CODING_H
