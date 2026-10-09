// render-stream/0 snapshot model: the values the mirror publishes and the codec encodes.
//
// Plain C++17, no engine or GDExtension types, header-only, so the mirror
// (rs0_mirror), the no-I/O codec (rs0_codec), the publisher (rs0_publish) and
// their unit tests share one definition. The wire format these structs encode to
// is specified in experiments/render-stream/protocol/render-stream-0.md; the
// gate-0 behaviour that fills them is in protocol/gate0-design.md. Field order
// here follows the wire's JSON key order and block float order.
//
// Ids are wire ids, never engine RIDs: one counter per kind (canvas, item) per
// session, starting at 1, never reused.
#ifndef GRC_RS0_SNAPSHOT_H
#define GRC_RS0_SNAPSHOT_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace grc {
namespace rs0 {

// ----------------------------------------------------------------------------- constants

// "GRS0\r\n\x1a\n". A different byte 3 is a different major version.
inline constexpr std::array<std::uint8_t, 8> kMagic = {0x47, 0x52, 0x53, 0x30,
                                                       0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocol = "render-stream/0";
inline constexpr const char *kPublication = "complete-snapshot-per-frame";

// Floats per entry in the transaction blocks (render-stream-0.md "Blocks").
inline constexpr std::size_t kItemFloats = 18;   // xform 6, modulate 4, self_modulate 4, custom rect 4
inline constexpr std::size_t kCanvasFloats = 6;  // xform 6
inline constexpr std::size_t kRectFloats = 8;    // rect 4, colour 4

// Mirror capacity (exceeding either is the sticky failure `mirror-capacity`).
inline constexpr std::size_t kMaxLiveItems = 4096;
inline constexpr std::size_t kMaxCommandsPerItem = 1024;

// Largest integer a JSON number may carry on the wire (2^53 - 1). Encoders
// saturate counters (ns totals) to this value.
inline constexpr std::uint64_t kMaxJsonInteger = 9007199254740991ULL;

// The root canvas found by the arm-time root query is always canvas wire id 1.
inline constexpr std::uint32_t kRootCanvasId = 1;

using Xform = std::array<float, 6>;  // x.x, x.y, y.x, y.y, origin.x, origin.y (Transform2D columns)
using Color4 = std::array<float, 4>; // r, g, b, a
using Rect4 = std::array<float, 4>;  // position.x, position.y, size.x, size.y

inline constexpr Xform kIdentityXform = {1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f};
inline constexpr Color4 kWhite = {1.0f, 1.0f, 1.0f, 1.0f};
inline constexpr Rect4 kZeroRect = {0.0f, 0.0f, 0.0f, 0.0f};

// ----------------------------------------------------------------------------- enums

// How a wire id came to exist. Gate 0 emits Created and RootQuery only;
// Adopted is reserved for late join (gate 8).
enum class Origin : std::uint8_t { Created, RootQuery, Adopted };

enum class CanvasRole : std::uint8_t { None, Root };  // None -> JSON null

enum class ParentKind : std::uint8_t { None, Canvas, Item };  // None -> JSON null

enum class CommandKind : std::uint8_t { AddRect, Unsupported };

enum class TransactionStatus : std::uint8_t { Ok, CaptureFailure };

enum class FailureReason : std::uint8_t { RootQueryFailed, PreExistingObject, MirrorCapacity };

enum class UnsupportedReason : std::uint8_t {
  UnsupportedOp,     // a hooked draw op other than add_rect, recorded in an item's commands
  UnsupportedState,  // non-null canvas_item_set_material on an item
  NonRootViewport,   // viewport_attach_canvas / viewport_set_canvas_transform on a non-root viewport
  ExtraCanvas,       // a second canvas attached to the root viewport
};

enum class SabotageKind : std::uint8_t { None, FreezeFrame, OmitUpdate, PerturbTransform };

enum class EndReason : std::uint8_t { Shutdown, Disarm };

// Wire spellings (render-stream-0.md). Each returns a string literal.
inline const char *to_wire(Origin v) {
  switch (v) {
  case Origin::Created: return "created";
  case Origin::RootQuery: return "root-query";
  case Origin::Adopted: return "adopted";
  }
  return "created";
}
inline const char *to_wire(ParentKind v) {
  return v == ParentKind::Canvas ? "canvas" : "item";  // None is encoded as null, never spelled
}
inline const char *to_wire(TransactionStatus v) {
  return v == TransactionStatus::Ok ? "ok" : "capture-failure";
}
inline const char *to_wire(FailureReason v) {
  switch (v) {
  case FailureReason::RootQueryFailed: return "root-query-failed";
  case FailureReason::PreExistingObject: return "pre-existing-object";
  case FailureReason::MirrorCapacity: return "mirror-capacity";
  }
  return "root-query-failed";
}
inline const char *to_wire(UnsupportedReason v) {
  switch (v) {
  case UnsupportedReason::UnsupportedOp: return "unsupported-op";
  case UnsupportedReason::UnsupportedState: return "unsupported-state";
  case UnsupportedReason::NonRootViewport: return "non-root-viewport";
  case UnsupportedReason::ExtraCanvas: return "extra-canvas";
  }
  return "unsupported-op";
}
inline const char *to_wire(SabotageKind v) {
  switch (v) {
  case SabotageKind::None: return "";  // None is encoded as null
  case SabotageKind::FreezeFrame: return "freeze-frame";
  case SabotageKind::OmitUpdate: return "omit-update";
  case SabotageKind::PerturbTransform: return "perturb-transform";
  }
  return "";
}
inline const char *to_wire(EndReason v) { return v == EndReason::Shutdown ? "shutdown" : "disarm"; }

// ----------------------------------------------------------------------------- session

struct EngineInfo {
  std::string version_string;   // e.g. "Godot Engine v4.5.1.stable.official"
  std::string sha256;           // 64 lowercase hex, of /proc/self/exe
  std::string display_server;   // "headless" on the capture host
  std::string rendering_driver;
  std::string rendering_method;
};

struct CaptureInfo {
  std::uint32_t calibrator_version = 0;    // the record's calibrator.version, as an integer
  std::vector<std::string> hooks_planned;  // sorted ascending (byte order) by the encoder
  std::vector<std::string> hooks_omitted;  // sorted ascending (byte order) by the encoder
};

struct ViewportInfo {
  std::uint32_t canvas_cull_mask = 0xFFFFFFFFu;
  std::uint32_t root_canvas = kRootCanvasId;
};

// Gate-0 values are fixed lists (render-stream-0.md "Session"); they are data
// here so the codec test can build the golden session from the same struct.
struct Features {
  std::vector<std::string> ops;
  std::vector<std::string> item_state;
  std::vector<std::string> observed_unsupported_ops;
  std::vector<std::string> unobserved;
  std::string publication = kPublication;
};

struct Sabotage {
  SabotageKind kind = SabotageKind::None;  // None -> "sabotage": null
  std::uint64_t frame = 0;
};

struct Session {
  std::string session_id;  // 32 lowercase hex (128 random bits)
  EngineInfo engine;
  CaptureInfo capture;
  ViewportInfo viewport;
  Features features;
  Sabotage sabotage;
  // Blocks, in this order.
  Color4 clear_color = {0.0f, 0.0f, 0.0f, 1.0f};  // RenderingServer::get_default_clear_color
  Xform root_canvas_xform = kIdentityXform;       // Viewport::get_canvas_transform
  Rect4 host_visible_rect = kZeroRect;            // Viewport::get_visible_rect (64x64 under --headless)
};

// ----------------------------------------------------------------------------- transaction

struct ParentRef {
  ParentKind kind = ParentKind::None;
  std::uint32_t id = 0;  // meaningful only when kind != None
};

struct Command {
  CommandKind kind = CommandKind::AddRect;
  // AddRect
  bool antialiased = false;
  Rect4 rect = kZeroRect;
  Color4 color = kWhite;
  // Unsupported: the hooked RenderingServer method name, e.g. "canvas_item_add_circle"
  std::string name;
};

struct ItemState {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;
  ParentRef parent;
  std::vector<std::uint32_t> children;  // engine append order, not draw order
  // RenderingServer defaults (renderer_canvas_cull.h:60, :88-94; renderer_canvas_render.h:474-478).
  Xform xform = kIdentityXform;
  Color4 modulate = kWhite;
  Color4 self_modulate = kWhite;
  bool visible = true;
  std::int32_t draw_index = 0;
  std::int32_t z_index = 0;
  bool clip = false;
  bool custom_rect = false;
  Rect4 custom_rect_rect = kZeroRect;
  std::uint32_t visibility_layer = 0xFFFFFFFFu;
  std::uint64_t content_version = 0;  // bumped by every add_* and every clear
  std::vector<Command> commands;
  bool unsupported_state = false;  // non-null material; reported in Snapshot::unsupported only
};

struct CanvasState {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;
  CanvasRole role = CanvasRole::None;
  bool attached = false;              // attached to the root viewport
  Xform xform = kIdentityXform;       // viewport_set_canvas_transform on the root viewport
  std::vector<std::uint32_t> items;   // engine append order
};

struct Failure {
  FailureReason reason = FailureReason::RootQueryFailed;
  std::string detail;  // printable ASCII; RIDs are written here in decimal, never as JSON numbers
};

struct UnsupportedRef {
  std::string op;                       // RenderingServer method name
  bool has_item = false;                // false -> "item": null (session-level conditions)
  std::uint32_t item = 0;
  UnsupportedReason reason = UnsupportedReason::UnsupportedOp;
};

struct Snapshot {
  std::uint64_t seq = 0;    // 1..N, contiguous, assigned by the publisher
  std::uint64_t frame = 0;  // frames_total at the frame callback that published it
  std::vector<Failure> failures;            // non-empty <=> status capture-failure
  std::vector<UnsupportedRef> unsupported;  // ordering: render-stream-0.md "Transaction"
  std::vector<CanvasState> canvases;        // sorted by id ascending
  std::vector<ItemState> items;             // sorted by id ascending

  TransactionStatus status() const {
    return failures.empty() ? TransactionStatus::Ok : TransactionStatus::CaptureFailure;
  }
};

// ----------------------------------------------------------------------------- end

struct EndStats {
  std::uint64_t bytes_total = 0;        // magic + every session/transaction record, excluding end
  std::uint64_t encode_ns_total = 0;    // session + transaction encode time
  std::uint64_t snapshot_ns_total = 0;  // mirror copy time (lock held)
  std::uint64_t max_record_bytes = 0;   // max of 4 + record_len over session/transaction records
};

struct End {
  std::uint64_t transactions = 0;
  EndReason reason = EndReason::Shutdown;
  EndStats stats;
};

}  // namespace rs0
}  // namespace grc

#endif  // GRC_RS0_SNAPSHOT_H
