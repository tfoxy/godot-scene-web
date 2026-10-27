// Gate 8 policy parsing and the D2 refusals (gate8-design.md D2, D4, D8, D9, Q6; G8w).
//
// Pure C++17, no engine types, so it is unit-testable without a Godot process (the ctest
// rs_gate8_policy_test). The environment variables it reads:
//
//   GRC_STREAM_VERSION    6 | 8 | 9 | 10 | 11, default 6. The wire version of FILE sinks only (render-stream-8.md
//                         "Which sinks speak /8"); the live listener negotiates per connection.
//                         9 (G8k9, render-stream-9.md) is /8 plus the texture-delivery wire; it is the
//                         only way `render-stream.9` is ever offered. 10 (CG1, render-stream-10.md)
//                         is /9 plus the back-buffer item state; it also installs the two
//                         conditional back-buffer hooks and is the only way `render-stream.10` is
//                         ever offered. 11 (W11b, render-stream-11.md) is /10 plus the carried-set
//                         rules, dynamic mesh surfaces and WB's stable content_version; it keeps
//                         /10's conditional hooks and is the only way `render-stream.11` is offered.
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
  // GRC_STREAM_VERSION: the wire version of file sinks. V6 (the default), V8, V9, V10 or V11.
  rs2::ProtocolVersion file_version = rs2::ProtocolVersion::V6;
  bool stream_version_set = false;  // GRC_STREAM_VERSION was present and non-empty
  bool adopt = false;               // GRC_ADOPT=arm
  bool decode_engine = false;       // GRC_TEXTURE_DECODE=engine
  bool float_formats = false;       // GRC_RESOURCE_FORMATS names a float payload format
  bool v8_sabotage = false;         // GRC_SABOTAGE names a kind only a /8 session may declare

  // Whether any variable that needs /8 is set.
  bool any() const { return adopt || decode_engine || float_formats || v8_sabotage; }
  // Whether the stream as a whole speaks /8 anywhere: a /8 file sink or a policy that forces it.
  bool speaks_v8() const { return rs2::is_v8_or_later(file_version) || any(); }
  // Whether the stream speaks /9 or later: GRC_STREAM_VERSION=9 or 10, and only that (G8k9; /10
  // carries /9's texture delivery, render-stream-10.md "Capture policy").
  bool speaks_v9() const { return rs2::is_v9_or_later(file_version); }
  // Whether the stream speaks /10: GRC_STREAM_VERSION=10, and only that (CG1). Also the switch
  // for the two conditional back-buffer hooks (render-stream-10.md "Capture").
  // W11b: also true at /11, which carries /10's item keys and shader time.
  bool speaks_v10() const { return rs2::is_v10_or_later(file_version); }
  // Whether the stream speaks /11: GRC_STREAM_VERSION=11, and only that (W11b).
  bool speaks_v11() const { return file_version == rs2::ProtocolVersion::V11; }
};

// Parses the four variables (each may be null). On a bad value returns false with *error naming
// the variable and its accepted values, and leaves *out default.
bool parse_gate8_policy(const char *stream_version, const char *adopt, const char *texture_decode,
                        const char *resource_formats, Gate8Policy *out, std::string *error);

// True for the seven sabotage kinds new at /8 (render-stream-8.md "Sabotage kinds").
bool sabotage_needs_v8(rs2::SabotageKind kind);

// True for the three sabotage kinds new at /11 (W11b, render-stream-11.md "Sabotage kinds"):
// cv-churn, stale-dynamic and keep-carried. They need GRC_STREAM_VERSION=11.
bool sabotage_needs_v11(rs2::SabotageKind kind);

// W11b (render-stream-11.md "Opt-in and version policy"): GRC_MESH_DYNAMIC (auto | off | all,
// default auto), GRC_MESH_DYNAMIC_FRAMES (1..60, default 4) and GRC_MESH_DYNAMIC_MAX_BYTES (an
// integer >= 0, default 65536); each may be null or empty. Read at /11 only (ignored below it). On
// a bad value returns false with *error naming the variable and leaves *out default.
bool parse_mesh_dynamic_policy(const char *mode, const char *frames, const char *max_bytes,
                               rs2::MeshDynamicPolicy *out, std::string *error);

// True when a comma-separated GRC_RESOURCE_FORMATS value names a float payload format.
bool formats_name_float(const char *resource_formats);

// D2's refusal: with `files` set (any file sink) a policy needs file_version V8. Returns false
// with *error "policy-needs-v8: ..." otherwise.
bool gate8_policy_allows(const Gate8Policy &policy, bool files, std::string *error);

// The live listener's subprotocols, most preferred first: ["render-stream.7", "render-stream.6",
// "render-stream.8"] by default (the default stays /7), "render-stream.8" first when
// GRC_STREAM_VERSION=8, and only "render-stream.8" under a gate 8 policy (D2). Under
// GRC_STREAM_VERSION=9 "render-stream.9" leads (then .8, .7, .6; under a gate 8 policy .9, .8):
// it is never offered otherwise (G8k9). Under GRC_STREAM_VERSION=10 "render-stream.10" leads
// (then .9, .8, .7, .6; under a gate 8 policy .10, .9, .8): never offered otherwise (CG1).
// Under GRC_STREAM_VERSION=11 "render-stream.11" leads, then /10's list (W11b).
std::vector<std::string> gate8_live_subprotocols(const Gate8Policy &policy);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_GATE8_POLICY_H
