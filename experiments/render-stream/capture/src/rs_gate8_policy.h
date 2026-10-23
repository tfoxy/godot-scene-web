// Gate 8 policy parsing and the D2 refusals (gate8-design.md D2, D4, D8, D9, Q6; G8w).
//
// Pure C++17, no engine types, so it is unit-testable without a Godot process (the ctest
// rs_gate8_policy_test). The environment variables it reads:
//
//   GRC_STREAM_VERSION    6 | 8, default 6. The wire version of FILE sinks only (render-stream-8.md
//                         "Which sinks speak /8"); the live listener negotiates per connection.
//   GRC_ADOPT             off | arm, default off. Late-join adoption at arm (D3-D7).
//   GRC_TEXTURE_DECODE    off | engine, default off. Host decode of block-compressed textures (D8).
//   GRC_RESOURCE_FORMATS  a float payload format (RF RGF RGBF RGBAF RH RGH RGBH RGBAH) counts as a
//                         gate 8 policy, because float payloads are legal at /8 only (D9).
//
// D2: any gate 8 policy with a file sink that does not speak /8 refuses to publish
// (`policy-needs-v8`); with no file sink the listener offers only render-stream.8, so no /6 or /7
// decoder sees a field it would reject.
#ifndef GRC_RS_GATE8_POLICY_H
#define GRC_RS_GATE8_POLICY_H

#include <string>
#include <vector>

#include "rs2_snapshot.h"

namespace grc {
namespace rs {

struct Gate8Policy {
  // GRC_STREAM_VERSION: the wire version of file sinks. V6 (the default) or V8.
  rs2::ProtocolVersion file_version = rs2::ProtocolVersion::V6;
  bool stream_version_set = false;  // GRC_STREAM_VERSION was present and non-empty
  bool adopt = false;               // GRC_ADOPT=arm
  bool decode_engine = false;       // GRC_TEXTURE_DECODE=engine
  bool float_formats = false;       // GRC_RESOURCE_FORMATS names a float payload format
  bool v8_sabotage = false;         // GRC_SABOTAGE names a kind only a /8 session may declare

  // Whether any variable that needs /8 is set.
  bool any() const { return adopt || decode_engine || float_formats || v8_sabotage; }
  // Whether the stream as a whole speaks /8 anywhere: a /8 file sink or a policy that forces it.
  bool speaks_v8() const { return file_version == rs2::ProtocolVersion::V8 || any(); }
};

// Parses the four variables (each may be null). On a bad value returns false with *error naming
// the variable and its accepted values, and leaves *out default.
bool parse_gate8_policy(const char *stream_version, const char *adopt, const char *texture_decode,
                        const char *resource_formats, Gate8Policy *out, std::string *error);

// True for the seven sabotage kinds new at /8 (render-stream-8.md "Sabotage kinds").
bool sabotage_needs_v8(rs2::SabotageKind kind);

// True when a comma-separated GRC_RESOURCE_FORMATS value names a float payload format.
bool formats_name_float(const char *resource_formats);

// D2's refusal: with `files` set (any file sink) a policy needs file_version V8. Returns false
// with *error "policy-needs-v8: ..." otherwise.
bool gate8_policy_allows(const Gate8Policy &policy, bool files, std::string *error);

// The live listener's subprotocols, most preferred first: ["render-stream.7", "render-stream.6",
// "render-stream.8"] by default (the default stays /7), "render-stream.8" first when
// GRC_STREAM_VERSION=8, and only "render-stream.8" under a gate 8 policy (D2).
std::vector<std::string> gate8_live_subprotocols(const Gate8Policy &policy);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_GATE8_POLICY_H
