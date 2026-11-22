// Gate 8 policy parsing and its refusals.
//
// Pure C++17, no engine types, so it is unit-testable without a Godot process (the ctest
// rs_gate8_policy_test). The environment variables it reads:
//
//   GRC_STREAM_VERSION    6 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18, default 6. The wire version of FILE sinks only (render-stream-8.md
//                         "Which sinks speak /8"); the live listener negotiates per connection.
//                         9 (G8k9, render-stream-9.md) is /8 plus the texture-delivery wire; it is the
//                         only way `render-stream.9` is ever offered. 10 (CG1, render-stream-10.md)
//                         is /9 plus the back-buffer item state; it also installs the two
//                         conditional back-buffer hooks and is the only way `render-stream.10` is
//                         ever offered. 11 (W11b, render-stream-11.md) is /10 plus the carried-set
//                         rules, dynamic mesh surfaces and WB's stable content_version; it keeps
//                         /10's conditional hooks and is the only way `render-stream.11` is offered.
//                         12 (PM5, render-stream-12.md) is /11 plus GPU particles; it installs /10's
//                         and /11's conditional hooks plus the 33 particles hooks, and is the only way
//                         `render-stream.12` is offered (first, then /11's list).
//   GRC_ADOPT             off | arm, default off. Late-join adoption at arm (D3-D7).
//   GRC_TEXTURE_DECODE    off | engine. Host decode of block-compressed textures (D8). TDE (F3):
//                         unset means engine on a stream that speaks /8 or later by any other
//                         means (a /8+ file sink, GRC_ADOPT=arm, a float format), and off on a
//                         plain /6 stream, which cannot carry a decoded texture's fields. An
//                         explicit `engine` is a policy (it forces /8); an explicit `off` pins the
//                         refusals.
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
  // GRC_STREAM_VERSION: the wire version of file sinks. V6 (the default), V8 to V19.
  rs2::ProtocolVersion file_version = rs2::ProtocolVersion::V6;
  bool stream_version_set = false;  // GRC_STREAM_VERSION was present and non-empty
  bool adopt = false;               // GRC_ADOPT=arm
  bool decode_engine = false;       // host decode is on: GRC_TEXTURE_DECODE=engine, or the TDE default
  bool decode_set = false;          // GRC_TEXTURE_DECODE was present and non-empty
  bool decode_default = false;      // decode_engine came from the TDE default (the variable was unset)
  bool float_formats = false;       // GRC_RESOURCE_FORMATS names a float payload format
  bool v8_sabotage = false;         // GRC_SABOTAGE names a kind only a /8 session may declare

  // Whether any variable that needs /8 is set.
  // The TDE default is not one: it applies only where the stream already speaks /8.
  bool any() const {
    return adopt || (decode_engine && !decode_default) || float_formats || v8_sabotage;
  }
  // Whether the stream as a whole speaks /8 anywhere: a /8 file sink or a policy that forces it.
  bool speaks_v8() const { return rs2::is_v8_or_later(file_version) || any(); }
  // TDE (F3): resolves the unset GRC_TEXTURE_DECODE default. Run after every other field is final
  // (the caller sets v8_sabotage after parsing); idempotent.
  void apply_decode_default() {
    if (!decode_set && !decode_engine && speaks_v8()) {
      decode_engine = true;
      decode_default = true;
    }
  }
  // Whether the stream speaks /9 or later: GRC_STREAM_VERSION=9 or 10, and only that (G8k9; /10
  // carries /9's texture delivery, render-stream-10.md "Capture policy").
  bool speaks_v9() const { return rs2::is_v9_or_later(file_version); }
  // Whether the stream speaks /10: GRC_STREAM_VERSION=10, and only that (CG1). Also the switch
  // for the two conditional back-buffer hooks (render-stream-10.md "Capture").
  // W11b: also true at /11, which carries /10's item keys and shader time.
  bool speaks_v10() const { return rs2::is_v10_or_later(file_version); }
  // Whether the stream speaks /11: GRC_STREAM_VERSION=11, and only that (W11b).
  // PM5: also true at /12, which carries /11's keys.
  bool speaks_v11() const { return rs2::is_v11_or_later(file_version); }
  // Whether the stream speaks /12: GRC_STREAM_VERSION=12, and only that (PM5).
  // W13b: also true at /13, which is /12 with predicted blocks.
  bool speaks_v12() const { return rs2::is_v12_or_later(file_version); }
  // Whether the stream speaks /13: GRC_STREAM_VERSION=13 (W13b).
  // ID3: also true at /14, which is /13 plus item_meta v2.
  bool speaks_v13() const { return rs2::is_v13_or_later(file_version); }
  // Whether the file sinks speak /14: GRC_STREAM_VERSION=14 (ID3, render-stream-14.md); also
  // true at /15, which is /14 plus hints and the size override.
  bool speaks_v14() const { return rs2::is_v14_or_later(file_version); }
  // Whether the stream speaks /15: GRC_STREAM_VERSION=15 (render-stream-15.md). The switch for
  // the hint table and the size override's wire key and version bump. VS2: also true at /16,
  // which is /15 plus viewport surfaces.
  bool speaks_v15() const { return rs2::is_v15_or_later(file_version); }
  // Whether the stream speaks /16: GRC_STREAM_VERSION=16 (render-stream-16.md "Who speaks /16"):
  // file sinks write /16 and the live listener lists only render-stream.16.
  bool speaks_v16() const { return rs2::is_v16(file_version); }
  // /18 selects only render-stream.18 and widens the live credit-window range.
  bool speaks_v19() const { return file_version == rs2::ProtocolVersion::V19; }
  bool speaks_v18() const { return file_version == rs2::ProtocolVersion::V18; }
};

// VS2 (viewport-surfaces-design.md D3; render-stream-16.md "Session: viewports"), read at load:
//   GRC_VIEWPORTS          on | off, default on. off: the twenty `viewport` hooks are not planned
//                          and a /16 session says "viewports":"off".
//   GRC_VIEWPORT_SABOTAGE  empty | no-adjacency | no-node-route | wrong-order (test knobs, never on
//                          the wire): no-adjacency zeroes the hooks' adjacent viewport (hooks.cpp);
//                          the other two act in rs_adopt.cpp.
enum class ViewportSabotage : unsigned char { None, NoAdjacency, NoNodeRoute, WrongOrder };
struct ViewportsPolicy {
  bool on = true;
  ViewportSabotage sabotage = ViewportSabotage::None;
};
// Each may be null or empty. On a bad value returns false with *error naming the variable and its
// accepted values, and leaves *out default.
bool parse_viewports_policy(const char *viewports, const char *sabotage, ViewportsPolicy *out,
                            std::string *error);
const char *viewport_sabotage_name(ViewportSabotage sabotage);

// VS2 (viewport-surfaces-design.md D14): GRC_RESOURCE_HINTS = on | off, default on (null or empty:
// on), read when the stream speaks /15 or later. Hints are on when the stream speaks /15 or later,
// its payloads are not all inline and this is not off.
bool parse_resource_hints(const char *value, bool *on, std::string *error);

// Parses the four variables (each may be null). On a bad value returns false with *error naming
// the variable and its accepted values, and leaves *out default.
bool parse_gate8_policy(const char *stream_version, const char *adopt, const char *texture_decode,
                        const char *resource_formats, Gate8Policy *out, std::string *error);

// The conditional hook families a GRC_STREAM_VERSION installs. Every version from /12 on is a
// superset of /12's wire (later versions add records, blocks or keys that need no further hook),
// so the families are thresholds, not a list of known versions: a list silently dropped particles,
// multimesh and back-buffer hooks the first time a version was added without editing it.
struct HookVersionPlan {
  bool backbuffer = false;     // /10 and /11's item keys, carried from /12 on
  bool multimesh = false;      // /11's multimesh table, carried from /12 on
  bool particles = false;      // /12's GPU particles
  bool size_override = false;  // /15's texture_set_size_override
};
// Null, empty or non-numeric means no conditional hooks (a /6 stream).
HookVersionPlan hook_version_plan(const char *stream_version);

// True for the seven sabotage kinds new at /8 (render-stream-8.md "Sabotage kinds").
bool sabotage_needs_v8(rs2::SabotageKind kind);

// True for the three sabotage kinds new at /11 (W11b, render-stream-11.md "Sabotage kinds"):
// cv-churn, stale-dynamic and keep-carried. They need GRC_STREAM_VERSION=11.
bool sabotage_needs_v11(rs2::SabotageKind kind);
// PM5 (render-stream-12.md "Sabotages"): perturb-seed and drop-restart need GRC_STREAM_VERSION=12.
bool sabotage_needs_v12(rs2::SabotageKind kind);

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
// Under GRC_STREAM_VERSION=16 the list is exactly {"render-stream.16"} (render-stream-16.md "Who
// speaks /16": no per-connection downgrade).
std::vector<std::string> gate8_live_subprotocols(const Gate8Policy &policy);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_GATE8_POLICY_H
