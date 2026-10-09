// render-stream/1 snapshot model: the values a /1 encoder (rs1_codec) and diff (rs1_diff) work
// over.
//
// Plain C++17, no engine or GDExtension types, header-only, so the codec, the diff, their unit
// tests and (from G1b2) the mirror and publisher can share one definition. The wire format these
// structs encode to is specified in experiments/render-stream/protocol/render-stream-1.md; the
// gate-1 behaviour that fills them in production is protocol/gate1-design.md. Field order here
// follows the wire's JSON key order and block float order.
//
// Two structs matter:
//   Snapshot    the mirror's complete captured state for one frame (every canvas/item present,
//               every item's full `commands`, `unsupported`/`failures` already computed -- by
//               the mirror in production, e.g. draw-index-tie detection per gate1-design.md
//               G1b2; by hand in golden/test code here). This is never encoded directly.
//   Transaction the wire-level transaction record: either a full copy of a Snapshot
//               (make_full(), rs1_diff.h) or a patch against a base Snapshot (make_patch()),
//               with items' `commands` nullable per the inclusion rule. encode_transaction()
//               (rs1_codec.h) turns a Transaction into bytes.
//
// Ids are wire ids, never engine RIDs: one counter per kind (canvas, item) per session, starting
// at 1, never reused (render-stream-0.md, unchanged by /1).
#ifndef GRC_RS1_SNAPSHOT_H
#define GRC_RS1_SNAPSHOT_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace grc {
namespace rs1 {

// ----------------------------------------------------------------------------- constants

// "GRS1\r\n\x1a\n". A different byte 3 is a different major version.
inline constexpr std::array<std::uint8_t, 8> kMagic = {0x47, 0x52, 0x53, 0x31,
                                                       0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocol = "render-stream/1";
inline constexpr const char *kPublication = "snapshot-or-patch";

// Floats per entry in the transaction blocks (render-stream-1.md "Transaction record").
inline constexpr std::size_t kItemFloats = 18;   // xform 6, modulate 4, self_modulate 4, custom rect 4
inline constexpr std::size_t kCanvasFloats = 6;  // xform 6
inline constexpr std::size_t kRectFloats = 8;    // rect 4, colour 4

inline constexpr std::size_t kMaxLiveItems = 4096;
inline constexpr std::size_t kMaxCommandsPerItem = 1024;

inline constexpr std::uint64_t kMaxJsonInteger = 9007199254740991ULL;

inline constexpr std::uint32_t kRootCanvasId = 1;

using Xform = std::array<float, 6>;  // x.x, x.y, y.x, y.y, origin.x, origin.y (Transform2D columns)
using Color4 = std::array<float, 4>; // r, g, b, a
using Rect4 = std::array<float, 4>;  // position.x, position.y, size.x, size.y

inline constexpr Xform kIdentityXform = {1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f};
inline constexpr Color4 kWhite = {1.0f, 1.0f, 1.0f, 1.0f};
inline constexpr Rect4 kZeroRect = {0.0f, 0.0f, 0.0f, 0.0f};

// ----------------------------------------------------------------------------- enums

enum class Origin : std::uint8_t { Created, RootQuery, Adopted };

enum class CanvasRole : std::uint8_t { None, Root };  // None -> JSON null

enum class ParentKind : std::uint8_t { None, Canvas, Item };  // None -> JSON null

enum class CommandKind : std::uint8_t { AddRect, Unsupported };

enum class TransactionStatus : std::uint8_t { Ok, CaptureFailure };

enum class FailureReason : std::uint8_t {
  RootQueryFailed,
  PreExistingObject,
  MirrorCapacity,
  RootSizeEnforceFailed,  // new at /1 (render-stream-1.md "Unsupported reasons")
};

enum class UnsupportedReason : std::uint8_t {
  UnsupportedOp,
  UnsupportedState,
  NonRootViewport,
  ExtraCanvas,
  DrawIndexTie,        // new at /1: item-level, invariant 9
  DegenerateHostSize,   // new at /1: session-level
};

enum class SabotageKind : std::uint8_t {
  None,
  FreezeFrame,
  OmitUpdate,
  PerturbTransform,
  OmitOp,
  PatchDropItem,
  DropMessage,
  IgnoreCredit,
  StaleCoalesce,
};

enum class EndReason : std::uint8_t { Shutdown, Disarm };

enum class Transport : std::uint8_t { File, Websocket };

enum class Encoding : std::uint8_t { Full, Patch };

enum class StretchMode : std::uint8_t { Disabled, CanvasItems, Viewport };
enum class StretchAspect : std::uint8_t { Ignore, Keep, KeepWidth, KeepHeight, Expand };
enum class ScaleMode : std::uint8_t { Fractional, Integer };
enum class RootSizePolicy : std::uint8_t { Observe, EnforceMinSize };
enum class HostSizeStatus : std::uint8_t { Match, DegenerateVisible, DegenerateWindow };

// Wire spellings (render-stream-1.md). Each returns a string literal.
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
  case FailureReason::RootSizeEnforceFailed: return "root-size-enforce-failed";
  }
  return "root-query-failed";
}
inline const char *to_wire(UnsupportedReason v) {
  switch (v) {
  case UnsupportedReason::UnsupportedOp: return "unsupported-op";
  case UnsupportedReason::UnsupportedState: return "unsupported-state";
  case UnsupportedReason::NonRootViewport: return "non-root-viewport";
  case UnsupportedReason::ExtraCanvas: return "extra-canvas";
  case UnsupportedReason::DrawIndexTie: return "draw-index-tie";
  case UnsupportedReason::DegenerateHostSize: return "degenerate-host-size";
  }
  return "unsupported-op";
}
inline const char *to_wire(SabotageKind v) {
  switch (v) {
  case SabotageKind::None: return "";  // None is encoded as null
  case SabotageKind::FreezeFrame: return "freeze-frame";
  case SabotageKind::OmitUpdate: return "omit-update";
  case SabotageKind::PerturbTransform: return "perturb-transform";
  case SabotageKind::OmitOp: return "omit-op";
  case SabotageKind::PatchDropItem: return "patch-drop-item";
  case SabotageKind::DropMessage: return "drop-message";
  case SabotageKind::IgnoreCredit: return "ignore-credit";
  case SabotageKind::StaleCoalesce: return "stale-coalesce";
  }
  return "";
}
inline const char *to_wire(EndReason v) { return v == EndReason::Shutdown ? "shutdown" : "disarm"; }
inline const char *to_wire(Transport v) { return v == Transport::File ? "file" : "websocket"; }
inline const char *to_wire(Encoding v) { return v == Encoding::Full ? "full" : "patch"; }
inline const char *to_wire(StretchMode v) {
  switch (v) {
  case StretchMode::Disabled: return "disabled";
  case StretchMode::CanvasItems: return "canvas_items";
  case StretchMode::Viewport: return "viewport";
  }
  return "disabled";
}
inline const char *to_wire(StretchAspect v) {
  switch (v) {
  case StretchAspect::Ignore: return "ignore";
  case StretchAspect::Keep: return "keep";
  case StretchAspect::KeepWidth: return "keep_width";
  case StretchAspect::KeepHeight: return "keep_height";
  case StretchAspect::Expand: return "expand";
  }
  return "ignore";
}
inline const char *to_wire(ScaleMode v) { return v == ScaleMode::Fractional ? "fractional" : "integer"; }
inline const char *to_wire(RootSizePolicy v) {
  return v == RootSizePolicy::Observe ? "observe" : "enforce-min-size";
}
inline const char *to_wire(HostSizeStatus v) {
  switch (v) {
  case HostSizeStatus::Match: return "match";
  case HostSizeStatus::DegenerateVisible: return "degenerate-visible";
  case HostSizeStatus::DegenerateWindow: return "degenerate-window";
  }
  return "match";
}

// ----------------------------------------------------------------------------- session

struct EngineInfo {
  std::string version_string;
  std::string sha256;
  std::string display_server;
  std::string rendering_driver;
  std::string rendering_method;
};

struct CaptureInfo {
  std::uint32_t calibrator_version = 0;
  std::vector<std::string> hooks_planned;  // sorted ascending (byte order) by the encoder
  std::vector<std::string> hooks_omitted;  // sorted ascending (byte order) by the encoder
};

struct StreamInfo {
  std::string stream_id;        // 32 lowercase hex, fresh per stream
  bool has_connection = false;   // false -> "connection": null (file transport)
  std::uint32_t connection = 0;  // 1, 2, ... (live connection number); meaningful only if has_connection
  Transport transport = Transport::File;
  Encoding encoding = Encoding::Full;  // the sink's encoding, not this transaction's
};

struct Stretch {
  StretchMode mode = StretchMode::Disabled;
  StretchAspect aspect = StretchAspect::Ignore;
  ScaleMode scale_mode = ScaleMode::Fractional;
};

struct ViewportInfo {
  std::uint32_t canvas_cull_mask = 0xFFFFFFFFu;
  std::uint32_t root_canvas = kRootCanvasId;
  std::array<std::int32_t, 2> logical_size = {0, 0};
  Stretch stretch;
  // "stretch_applied_by":"receiver" is the only value at gate 1 (render-stream-1.md "Session").
  RootSizePolicy root_size_policy = RootSizePolicy::Observe;
  HostSizeStatus host_size_status = HostSizeStatus::Match;
  std::array<std::int32_t, 2> host_window_size = {0, 0};
};

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
  bool has_op = false;    // true only for OmitOp
  std::string op;         // the RenderingServer method name; meaningful only if has_op
};

struct Session {
  std::string session_id;  // 32 lowercase hex
  StreamInfo stream;
  EngineInfo engine;
  CaptureInfo capture;
  ViewportInfo viewport;
  Features features;
  Sabotage sabotage;
  // Blocks, in this order.
  Color4 clear_color = {0.0f, 0.0f, 0.0f, 1.0f};
  Xform root_canvas_xform = kIdentityXform;
  Rect4 host_visible_rect = kZeroRect;
  Xform host_final_xform = kIdentityXform;
  float content_scale_factor = 1.0f;
};

// ----------------------------------------------------------------------------- shared item/canvas state

struct ParentRef {
  ParentKind kind = ParentKind::None;
  std::uint32_t id = 0;
};

struct Command {
  CommandKind kind = CommandKind::AddRect;
  bool antialiased = false;
  Rect4 rect = kZeroRect;
  Color4 color = kWhite;
  std::string name;  // Unsupported: the hooked RenderingServer method name
};

// The mirror's full state for one item at one frame: always carries its complete `commands`.
// Never encoded directly -- see ItemEntry for the wire-level, possibly-null-commands form.
struct ItemState {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;
  ParentRef parent;
  std::vector<std::uint32_t> children;  // engine append order, not draw order
  Xform xform = kIdentityXform;
  Color4 modulate = kWhite;
  Color4 self_modulate = kWhite;
  bool visible = true;
  std::int32_t draw_index = 0;
  std::int32_t z_index = 0;
  bool z_relative = true;   // RS default (renderer_canvas_cull.h); new at /1
  bool behind = false;      // RS default; new at /1
  bool clip = false;
  bool custom_rect = false;
  Rect4 custom_rect_rect = kZeroRect;
  std::uint32_t visibility_layer = 0xFFFFFFFFu;
  std::uint64_t content_version = 0;
  std::vector<Command> commands;
};

struct CanvasState {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;
  CanvasRole role = CanvasRole::None;
  bool attached = false;
  Xform xform = kIdentityXform;
  std::vector<std::uint32_t> items;  // engine append order
};

struct Failure {
  FailureReason reason = FailureReason::RootQueryFailed;
  std::string detail;
};

struct UnsupportedRef {
  std::string op;
  bool has_item = false;  // false -> "item": null (session-level conditions)
  std::uint32_t item = 0;
  UnsupportedReason reason = UnsupportedReason::UnsupportedOp;
};

// The mirror's complete captured state for one frame. `failures`/`unsupported` are given, not
// derived here (the mirror computes them in production, including draw-index-tie detection --
// gate1-design.md G1b2 -- which make_full()/make_patch() never recompute).
struct Snapshot {
  std::uint64_t seq = 0;
  std::uint64_t frame = 0;
  std::vector<Failure> failures;
  std::vector<UnsupportedRef> unsupported;
  std::vector<CanvasState> canvases;  // sorted by id ascending
  std::vector<ItemState> items;       // sorted by id ascending

  TransactionStatus status() const {
    return failures.empty() ? TransactionStatus::Ok : TransactionStatus::CaptureFailure;
  }
};

// ----------------------------------------------------------------------------- transaction (wire-level)

// One item entry as it appears on the wire inside a transaction: the full item state, plus
// whether `commands` is encoded as null (render-stream-1.md "Patch transactions": null exactly
// when the item existed in the base with the same content_version). `state.commands` is ignored
// when `commands_null` is true.
struct ItemEntry {
  ItemState state;
  bool commands_null = false;
};

// The wire-level transaction record: either a full copy of a Snapshot (encoding=Full, every
// canvas/item present, commands never null) or a patch against a base Snapshot (encoding=Patch,
// base_seq set, only new-or-different entries present, removed_* for the rest). `failures` and
// `unsupported` are always complete, never patched (render-stream-1.md "Patch transactions").
struct Transaction {
  std::uint64_t seq = 0;
  std::uint64_t frame = 0;
  Encoding encoding = Encoding::Full;
  std::optional<std::uint64_t> base_seq;  // unset -> "base_seq": null
  std::vector<Failure> failures;
  std::vector<UnsupportedRef> unsupported;
  std::vector<std::uint32_t> removed_canvases;  // ascending
  std::vector<std::uint32_t> removed_items;     // ascending
  std::vector<CanvasState> canvases;             // ascending by id; full entries
  std::vector<ItemEntry> items;                  // ascending by id

  TransactionStatus status() const {
    return failures.empty() ? TransactionStatus::Ok : TransactionStatus::CaptureFailure;
  }
};

// ----------------------------------------------------------------------------- end

struct EndStats {
  std::uint64_t bytes_total = 0;
  std::uint64_t encode_ns_total = 0;
  std::uint64_t snapshot_ns_total = 0;
  std::uint64_t diff_ns_total = 0;       // new at /1: time spent forming patches, 0 for a full stream
  std::uint64_t max_record_bytes = 0;
  std::uint64_t full_transactions = 0;   // new at /1
  std::uint64_t patch_transactions = 0;  // new at /1
};

struct End {
  std::uint64_t transactions = 0;
  EndReason reason = EndReason::Shutdown;
  EndStats stats;
};

}  // namespace rs1
}  // namespace grc

#endif  // GRC_RS1_SNAPSHOT_H
