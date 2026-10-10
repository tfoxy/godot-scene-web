// render-stream/2 encoder: Session/Transaction/End/ResourceRecord structs (rs2_snapshot.h) to
// wire bytes.
//
// Pure: no I/O, no engine or GDExtension types, no global state. The byte layout (record
// framing, the new u8 block type, canonical JSON key order, float32 LE blocks) is specified in
// experiments/render-stream/protocol/render-stream-2.md; the reference encoder is
// protocol/golden-2/make_golden.py, which capture/test/rs2_codec_test.cpp checks this file
// against byte for byte. Framing and canonical-JSON rules not mentioned there are unchanged from
// render-stream-0.md and render-stream-1.md.
#ifndef GRC_RS2_CODEC_H
#define GRC_RS2_CODEC_H

#include <cstdint>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs2 {

// The 8-byte file magic ("GRS2\r\n\x1a\n"), copied from kMagic.
std::vector<std::uint8_t> magic();

// render-stream-3.md / render-stream-4.md: the 8-byte magic for `version` (kMagic for V2,
// kMagicV3 for V3, kMagicV4 for V4). Added at G4e1 as an overload rather than a change to magic()
// above, so every existing golden-2 call site is unaffected.
std::vector<std::uint8_t> magic(ProtocolVersion version);

// Each function returns one complete wire record, length prefix included. Encoding is
// deterministic: the same struct always yields the same bytes.
//
// encode_session() sorts `session.capture.hooks_planned`/`hooks_omitted` and
// `session.resources.permitted_formats` ascending by byte value; every other array is emitted in
// the order the struct holds it. Every string is re-encoded with any byte outside printable
// ASCII (0x20-0x7E) replaced by '?'.
std::vector<std::uint8_t> encode_session(const Session &session);
std::vector<std::uint8_t> encode_transaction(const Transaction &transaction);
std::vector<std::uint8_t> encode_end(const End &end);

// encode_resource() wraps an already-built render-stream-texture/1 payload (ResourceRecord::
// payload) in a "resource" record (render-stream-2.md "Resource record"). It computes no hash
// and performs no validation of the payload's contents; `record.hash` is written verbatim.
std::vector<std::uint8_t> encode_resource(const ResourceRecord &record);

}  // namespace rs2
}  // namespace grc

#endif  // GRC_RS2_CODEC_H
