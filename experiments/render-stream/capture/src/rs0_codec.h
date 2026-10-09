// render-stream/0 encoder: Session/Snapshot/End structs (rs0_snapshot.h) to
// wire bytes.
//
// Pure: no I/O, no engine or GDExtension types, no global state. The byte
// layout (record framing, canonical JSON key order, float32 LE blocks) is
// specified in experiments/render-stream/protocol/render-stream-0.md; the
// reference encoder is protocol/golden/make_golden.py, which
// capture/test/rs0_codec_test.cpp checks this file against byte for byte.
#ifndef GRC_RS0_CODEC_H
#define GRC_RS0_CODEC_H

#include <cstdint>
#include <vector>

#include "rs0_snapshot.h"

namespace grc {
namespace rs0 {

// The 8-byte file magic ("GRS0\r\n\x1a\n"), copied from kMagic.
std::vector<std::uint8_t> magic();

// Each function returns one complete wire record, length prefix included:
// `u32le record_len` then the canonical-JSON meta and the float32 blocks
// render-stream-0.md describes for that record type. Encoding is
// deterministic: the same struct always yields the same bytes.
//
// encode_session() sorts `session.capture.hooks_planned` and
// `hooks_omitted` ascending by byte value; every other array is emitted in
// the order the struct holds it. Every string is re-encoded with any byte
// outside printable ASCII (0x20-0x7E) replaced by '?', per the spec's
// canonical-JSON rule.
std::vector<std::uint8_t> encode_session(const Session &session);
std::vector<std::uint8_t> encode_transaction(const Snapshot &snapshot);
std::vector<std::uint8_t> encode_end(const End &end);

}  // namespace rs0
}  // namespace grc

#endif  // GRC_RS0_CODEC_H
