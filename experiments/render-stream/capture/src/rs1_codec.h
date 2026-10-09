// render-stream/1 encoder: Session/Transaction/End structs (rs1_snapshot.h) to wire bytes.
//
// Pure: no I/O, no engine or GDExtension types, no global state. The byte layout (record
// framing, canonical JSON key order, float32 LE blocks) is specified in
// experiments/render-stream/protocol/render-stream-1.md; the reference encoder is
// protocol/golden-1/make_golden.py, which capture/test/rs1_codec_test.cpp checks this file
// against byte for byte. Framing and canonical-JSON rules are unchanged from render-stream-0.md.
#ifndef GRC_RS1_CODEC_H
#define GRC_RS1_CODEC_H

#include <cstdint>
#include <vector>

#include "rs1_snapshot.h"

namespace grc {
namespace rs1 {

// The 8-byte file magic ("GRS1\r\n\x1a\n"), copied from kMagic.
std::vector<std::uint8_t> magic();

// Each function returns one complete wire record, length prefix included. Encoding is
// deterministic: the same struct always yields the same bytes.
//
// encode_session() sorts `session.capture.hooks_planned` and `hooks_omitted` ascending by byte
// value; every other array is emitted in the order the struct holds it. Every string is
// re-encoded with any byte outside printable ASCII (0x20-0x7E) replaced by '?'.
std::vector<std::uint8_t> encode_session(const Session &session);
std::vector<std::uint8_t> encode_transaction(const Transaction &transaction);
std::vector<std::uint8_t> encode_end(const End &end);

}  // namespace rs1
}  // namespace grc

#endif  // GRC_RS1_CODEC_H
