// render-stream/2 snapshot model: the values a /2 encoder (rs2_codec) and diff (rs2_diff) work
// over. render-stream/2 is render-stream/1 plus textures (render-stream-2.md).
//
// Plain C++17, no engine or GDExtension types, header-only, so the codec, the diff, their unit
// tests and (from G2b2) the mirror and publisher can share one definition. The wire format these
// structs encode to is specified in experiments/render-stream/protocol/render-stream-2.md; the
// gate-2 behaviour that fills them in production is protocol/gate2-design.md. Field order here
// follows the wire's JSON key order and block float order.
//
// Three structs matter, as in rs1_snapshot.h:
//   Snapshot    the mirror's complete captured state for one frame (every canvas/item/texture
//               present, every item's full `commands`, `unsupported`/`failures` already computed
//               -- by the mirror in production; by hand in golden/test code here). Never encoded
//               directly.
//   Transaction the wire-level transaction record: either a full copy of a Snapshot
//               (make_full(), rs2_diff.h) or a patch against a base Snapshot (make_patch()), with
//               items'/textures' `commands`/entries nullable or omitted per the inclusion rule.
//               encode_transaction() (rs2_codec.h) turns a Transaction into bytes.
//   ResourceRecord  a standalone "resource" record: a content-addressed payload (an already-built
//               render-stream-texture/1 byte sequence) and its hash. Not part of a Snapshot --
//               resource records are a delivery mechanism, not resolved state (render-stream-2.md
//               "Resource record"). This file holds no texture-payload codec: computing or
//               verifying a render-stream-texture/1 payload's bytes is rs_texture_payload's job
//               (capture/src/rs_texture_payload.*, G2a), out of scope for G2b1's pure codec.
//
// Ids are wire ids, never engine RIDs: one counter per kind (canvas, item, texture) per session,
// starting at 1, never reused. Texture ids share ONE counter across image, placeholder and canvas
// kinds (render-stream-2.md D2), distinct from the item/canvas counters.
#ifndef GRC_RS2_SNAPSHOT_H
#define GRC_RS2_SNAPSHOT_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace grc {
namespace rs2 {

// ----------------------------------------------------------------------------------- constants

// "GRS2\r\n\x1a\n". A different byte 3 is a different major version.
inline constexpr std::array<std::uint8_t, 8> kMagic = {0x47, 0x52, 0x53, 0x32,
                                                       0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocol = "render-stream/2";
inline constexpr const char *kPublication = "snapshot-or-patch";
inline constexpr const char *kPayloadSchema = "render-stream-texture/1";

// render-stream/3 (G4e1, render-stream-3.md): /2 plus one draw command
// (AddMsdfTextureRectRegion) and one host sabotage kind (PerturbGlyph). Rather than fork this
// whole module the way rs1 forked from rs0, /3 is implemented AS a protocol-version switch on
// Session (Session::version) inside the same rs2_* modules (gate4-design.md G4e1: "Renaming files
// is not part of this contract"). encode_session() picks the magic/protocol string from
// Session::version; everything else -- the new CommandKind and SabotageKind values -- is always
// representable, since a /2 session simply never uses them.
inline constexpr std::array<std::uint8_t, 8> kMagicV3 = {0x47, 0x52, 0x53, 0x33,
                                                          0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocolV3 = "render-stream/3";

// render-stream/4 (G5w, render-stream-4.md): /3 plus eleven new draw/state commands, a mesh
// table, a new `i32` block (`cmd_i32`), a new `mesh_f32` transaction block and a new mesh payload
// format (`render-stream-mesh/1`). As with /3 (gate4-design.md G4e1), /4 is a protocol-version
// switch on Session, not a fork.
inline constexpr std::array<std::uint8_t, 8> kMagicV4 = {0x47, 0x52, 0x53, 0x34,
                                                          0x0D, 0x0A, 0x1A, 0x0A};
inline constexpr const char *kProtocolV4 = "render-stream/4";
inline constexpr const char *kMeshPayloadSchema = "render-stream-mesh/1";

enum class ProtocolVersion : std::uint8_t { V2, V3, V4 };

// Floats per entry in the transaction blocks (render-stream-2.md "Transaction record"). Item and
// canvas float layouts are unchanged from /1; texture entries carry no floats at all.
inline constexpr std::size_t kItemFloats = 18;    // xform 6, modulate 4, self_modulate 4, custom rect 4
inline constexpr std::size_t kCanvasFloats = 6;   // xform 6
inline constexpr std::size_t kAddRectFloats = 8;              // rect 4, colour 4
inline constexpr std::size_t kAddTextureRectFloats = 8;       // rect 4, modulate 4
inline constexpr std::size_t kAddTextureRectRegionFloats = 12;  // rect 4, src 4, modulate 4
// new at /3: rect 4, src 4, modulate 4, px_range 1, scale 1 (render-stream-3.md "Command").
inline constexpr std::size_t kAddMsdfTextureRectRegionFloats = 14;
// new at /4 (render-stream-4.md "Command"): fixed float counts; the variable-length ops
// (AddPolyline/AddMultiline/AddPrimitive/AddPolygon/AddTriangleArray) are computed from their
// points/colors/uvs vectors instead.
inline constexpr std::size_t kAddLineFloats = 9;        // from 2, to 2, colour 4, width 1
inline constexpr std::size_t kAddCircleFloats = 7;       // position 2, radius 1, colour 4
inline constexpr std::size_t kAddNinePatchFloats = 16;   // rect 4, source 4, margins 2+2, modulate 4
inline constexpr std::size_t kAddMeshFloats = 10;        // transform 6, modulate 4
inline constexpr std::size_t kAddSetTransformFloats = 6;  // transform 6
// render-stream-4.md "Mesh payload": the custom AABB occupies six floats in mesh_f32 per present
// (non-freed) mesh entry.
inline constexpr std::size_t kMeshAabbFloats = 6;

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

// ----------------------------------------------------------------------------------- enums
//
// Enums unchanged from /1 (Origin, CanvasRole, ParentKind, TransactionStatus, FailureReason,
// EndReason, Transport, Encoding, StretchMode, StretchAspect, ScaleMode, RootSizePolicy,
// HostSizeStatus) are redeclared here rather than reused across namespaces: rs1 and rs2 are
// frozen-independent, as rs0 and rs1 were (render-stream-2.md D1, "/1... stay as frozen, still-
// verified history").

enum class Origin : std::uint8_t { Created, RootQuery, Adopted };

enum class CanvasRole : std::uint8_t { None, Root };  // None -> JSON null

enum class ParentKind : std::uint8_t { None, Canvas, Item };  // None -> JSON null

// AddMsdfTextureRectRegion: new at /3 (render-stream-3.md "Command"). AddLine..AddClipIgnore: new
// at /4 (render-stream-4.md "Command").
enum class CommandKind : std::uint8_t {
  AddRect,
  AddTextureRect,
  AddTextureRectRegion,
  AddMsdfTextureRectRegion,
  AddLine,
  AddPolyline,
  AddMultiline,
  AddCircle,
  AddPrimitive,
  AddPolygon,
  AddTriangleArray,
  AddNinePatch,
  AddMesh,
  AddSetTransform,
  AddClipIgnore,
  Unsupported,
};

// CanvasTextureHeadless (G2d): a texture draw naming RID() on a headless host, whose dummy
// storage's canvas_texture_allocate() returns RID() (render-stream-2.md "Commands").
// UnknownMesh/SkinnedGeometry: new at /4 (render-stream-4.md "Command"; D16).
enum class UnsupportedCmdReason : std::uint8_t {
  UnsupportedOp,
  UnknownTexture,
  CanvasTextureHeadless,
  UnknownMesh,
  SkinnedGeometry,
};

enum class TransactionStatus : std::uint8_t { Ok, CaptureFailure };

enum class FailureReason : std::uint8_t {
  RootQueryFailed,
  PreExistingObject,
  MirrorCapacity,
  RootSizeEnforceFailed,
};

enum class UnsupportedReason : std::uint8_t {
  UnsupportedOp,
  UnsupportedState,
  NonRootViewport,
  ExtraCanvas,
  DrawIndexTie,
  DegenerateHostSize,
  UnknownTexture,       // new at /2: derived from an unsupported "unknown-texture" command
  UnsupportedTexture,   // new at /2: a texture-rect command naming an unsupported texture entry
  CanvasTextureHeadless,  // G2d: derived from an unsupported "canvas-texture-headless" command
  UnknownMesh,          // new at /4: derived from an unsupported "unknown-mesh" command
  SkinnedGeometry,      // new at /4: derived from an unsupported "skinned-geometry" command
  UnsupportedMesh,      // new at /4: an add_mesh command naming an unsupported mesh entry
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
  StaleTexture,            // new at /2
  WrongHash,               // new at /2
  SpuriousTextureUpdate,   // new at /2
  DropResource,            // new at /2 (G2c2)
  Unpin,                   // new at /2 (G2c2)
  PerturbGlyph,            // new at /3 (G4e1/G4e2, render-stream-3.md)
  PerturbVertex,           // new at /4 (G5w, render-stream-4.md)
};

enum class EndReason : std::uint8_t { Shutdown, Disarm };

enum class Transport : std::uint8_t { File, Websocket };

enum class Encoding : std::uint8_t { Full, Patch };

enum class StretchMode : std::uint8_t { Disabled, CanvasItems, Viewport };
enum class StretchAspect : std::uint8_t { Ignore, Keep, KeepWidth, KeepHeight, Expand };
enum class ScaleMode : std::uint8_t { Fractional, Integer };
enum class RootSizePolicy : std::uint8_t { Observe, EnforceMinSize };
enum class HostSizeStatus : std::uint8_t { Match, DegenerateVisible, DegenerateWindow };

// --- new at /2: textures, filter/repeat, resource delivery -----------------------------------

enum class TextureKind : std::uint8_t { Image, Placeholder, Canvas };
enum class TextureStatus : std::uint8_t { Ok, Unsupported, Freed };
enum class TextureReason : std::uint8_t {
  UnsupportedFormat,
  PayloadTooLarge,
  PayloadUnavailable,
  UpdateShapeMismatch,
  LayeredUpdate,
  UnknownTexture,
  CanvasTextureChannel,
};

// RenderingServer.CanvasItemTextureFilter / CanvasItemTextureRepeat order (servers/rendering_
// server.h:925-942), used both for an item's own fields and the transaction-level defaults.
enum class Filter : std::uint8_t {
  Default, Nearest, Linear, NearestMipmaps, LinearMipmaps, NearestMipmapsAnisotropic,
  LinearMipmapsAnisotropic,
};
enum class Repeat : std::uint8_t { Default, Disabled, Enabled, Mirror };

enum class Delivery : std::uint8_t { OutOfBand, Inline, Mixed };
enum class Fetch : std::uint8_t { Http, Directory, None };
enum class Auth : std::uint8_t { None, Bearer };

// --- new at /4: mesh table, add_nine_patch axis modes (render-stream-4.md) --------------------

enum class AxisStretchMode : std::uint8_t { Stretch, Tile, TileFit };

// render-stream-4.md "Mesh payload": the five RenderingServer 2D primitive types a surface may
// declare.
enum class Primitive : std::uint8_t { Points, Lines, LineStrip, Triangles, TriangleStrip };

enum class MeshStatus : std::uint8_t { Ok, Unsupported, Freed };
enum class MeshReason : std::uint8_t { MeshFormat, MeshBlendShapes, PayloadTooLarge };

// Wire spellings (render-stream-2.md). Each returns a string literal.
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
  case UnsupportedReason::UnknownTexture: return "unknown-texture";
  case UnsupportedReason::UnsupportedTexture: return "unsupported-texture";
  case UnsupportedReason::CanvasTextureHeadless: return "canvas-texture-headless";
  case UnsupportedReason::UnknownMesh: return "unknown-mesh";
  case UnsupportedReason::SkinnedGeometry: return "skinned-geometry";
  case UnsupportedReason::UnsupportedMesh: return "unsupported-mesh";
  }
  return "unsupported-op";
}
inline const char *to_wire(UnsupportedCmdReason v) {
  switch (v) {
  case UnsupportedCmdReason::UnsupportedOp: return "unsupported-op";
  case UnsupportedCmdReason::UnknownTexture: return "unknown-texture";
  case UnsupportedCmdReason::CanvasTextureHeadless: return "canvas-texture-headless";
  case UnsupportedCmdReason::UnknownMesh: return "unknown-mesh";
  case UnsupportedCmdReason::SkinnedGeometry: return "skinned-geometry";
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
  case SabotageKind::StaleTexture: return "stale-texture";
  case SabotageKind::WrongHash: return "wrong-hash";
  case SabotageKind::SpuriousTextureUpdate: return "spurious-texture-update";
  case SabotageKind::DropResource: return "drop-resource";
  case SabotageKind::Unpin: return "unpin";
  case SabotageKind::PerturbGlyph: return "perturb-glyph";
  case SabotageKind::PerturbVertex: return "perturb-vertex";
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
inline const char *to_wire(TextureKind v) {
  switch (v) {
  case TextureKind::Image: return "image";
  case TextureKind::Placeholder: return "placeholder";
  case TextureKind::Canvas: return "canvas";
  }
  return "image";
}
inline const char *to_wire(TextureStatus v) {
  switch (v) {
  case TextureStatus::Ok: return "ok";
  case TextureStatus::Unsupported: return "unsupported";
  case TextureStatus::Freed: return "freed";
  }
  return "ok";
}
inline const char *to_wire(TextureReason v) {
  switch (v) {
  case TextureReason::UnsupportedFormat: return "unsupported-format";
  case TextureReason::PayloadTooLarge: return "payload-too-large";
  case TextureReason::PayloadUnavailable: return "payload-unavailable";
  case TextureReason::UpdateShapeMismatch: return "update-shape-mismatch";
  case TextureReason::LayeredUpdate: return "layered-update";
  case TextureReason::UnknownTexture: return "unknown-texture";
  case TextureReason::CanvasTextureChannel: return "canvas-texture-channel";
  }
  return "unsupported-format";
}
inline const char *to_wire(Filter v) {
  switch (v) {
  case Filter::Default: return "default";
  case Filter::Nearest: return "nearest";
  case Filter::Linear: return "linear";
  case Filter::NearestMipmaps: return "nearest_mipmaps";
  case Filter::LinearMipmaps: return "linear_mipmaps";
  case Filter::NearestMipmapsAnisotropic: return "nearest_mipmaps_anisotropic";
  case Filter::LinearMipmapsAnisotropic: return "linear_mipmaps_anisotropic";
  }
  return "default";
}
inline const char *to_wire(Repeat v) {
  switch (v) {
  case Repeat::Default: return "default";
  case Repeat::Disabled: return "disabled";
  case Repeat::Enabled: return "enabled";
  case Repeat::Mirror: return "mirror";
  }
  return "default";
}
inline const char *to_wire(Delivery v) {
  switch (v) {
  case Delivery::OutOfBand: return "out-of-band";
  case Delivery::Inline: return "inline";
  case Delivery::Mixed: return "mixed";
  }
  return "out-of-band";
}
inline const char *to_wire(Fetch v) {
  switch (v) {
  case Fetch::Http: return "http";
  case Fetch::Directory: return "directory";
  case Fetch::None: return "none";
  }
  return "none";
}
inline const char *to_wire(Auth v) { return v == Auth::Bearer ? "bearer" : "none"; }
inline const char *to_wire(AxisStretchMode v) {
  switch (v) {
  case AxisStretchMode::Stretch: return "stretch";
  case AxisStretchMode::Tile: return "tile";
  case AxisStretchMode::TileFit: return "tile_fit";
  }
  return "stretch";
}
inline const char *to_wire(Primitive v) {
  switch (v) {
  case Primitive::Points: return "points";
  case Primitive::Lines: return "lines";
  case Primitive::LineStrip: return "line_strip";
  case Primitive::Triangles: return "triangles";
  case Primitive::TriangleStrip: return "triangle_strip";
  }
  return "triangles";
}
inline const char *to_wire(MeshStatus v) {
  switch (v) {
  case MeshStatus::Ok: return "ok";
  case MeshStatus::Unsupported: return "unsupported";
  case MeshStatus::Freed: return "freed";
  }
  return "ok";
}
inline const char *to_wire(MeshReason v) {
  switch (v) {
  case MeshReason::MeshFormat: return "mesh-format";
  case MeshReason::MeshBlendShapes: return "mesh-blend-shapes";
  case MeshReason::PayloadTooLarge: return "payload-too-large";
  }
  return "mesh-format";
}

// ----------------------------------------------------------------------------------- session

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
  std::string stream_id;
  bool has_connection = false;
  std::uint32_t connection = 0;
  Transport transport = Transport::File;
  Encoding encoding = Encoding::Full;
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
  RootSizePolicy root_size_policy = RootSizePolicy::Observe;
  HostSizeStatus host_size_status = HostSizeStatus::Match;
  std::array<std::int32_t, 2> host_window_size = {0, 0};
};

// render-stream-2.md session "resources": the resource policy for this stream.
struct ResourcesInfo {
  Delivery delivery = Delivery::OutOfBand;
  std::uint64_t inline_max_bytes = 0;
  std::uint64_t max_payload_bytes = 1;
  std::vector<std::string> permitted_formats;  // sorted ascending (byte order) by the encoder
  Fetch fetch = Fetch::Directory;
  bool has_http_path = false;  // non-null exactly for fetch == Http
  std::string http_path;
  Auth auth = Auth::None;
};

// render-stream-2.md session "features.unsupported_resources" (G2d): a resource kind this host
// refuses, and why -- canvas_texture on a headless host (canvas-texture-headless).
struct UnsupportedResource {
  std::string resource;
  std::string reason;
};

struct Features {
  std::vector<std::string> ops;
  std::vector<std::string> item_state;
  std::vector<std::string> resources;  // new at /2
  std::vector<UnsupportedResource> unsupported_resources;  // G2d; sorted by resource
  std::vector<std::string> observed_unsupported_ops;
  std::vector<std::string> unobserved;
  std::string publication = kPublication;
};

struct Sabotage {
  SabotageKind kind = SabotageKind::None;  // None -> "sabotage": null
  std::uint64_t frame = 0;
  bool has_op = false;
  std::string op;
};

struct Session {
  // Which wire format encode_session()/encode_transaction() produce (render-stream-3.md
  // "render-stream/3"). Defaults to V2, so existing /2 callers that never set this field are
  // unaffected -- golden-2/ must keep passing unchanged (gate4-design.md G4e1).
  ProtocolVersion version = ProtocolVersion::V2;
  std::string session_id;
  StreamInfo stream;
  EngineInfo engine;
  CaptureInfo capture;
  ViewportInfo viewport;
  ResourcesInfo resources;  // new at /2, between viewport and features
  Features features;
  Sabotage sabotage;
  Color4 clear_color = {0.0f, 0.0f, 0.0f, 1.0f};
  Xform root_canvas_xform = kIdentityXform;
  Rect4 host_visible_rect = kZeroRect;
  Xform host_final_xform = kIdentityXform;
  float content_scale_factor = 1.0f;
};

// ----------------------------------------------------------------------------------- shared item/canvas state

struct ParentRef {
  ParentKind kind = ParentKind::None;
  std::uint32_t id = 0;
};

using Point2 = std::array<float, 2>;
inline constexpr Point2 kZeroPoint2 = {0.0f, 0.0f};

// One command. Which fields are meaningful is determined by `kind` (render-stream-2.md
// "Commands"; render-stream-3.md "Command" for AddMsdfTextureRectRegion; render-stream-4.md
// "Command" for AddLine..AddClipIgnore):
//   AddRect                   antialiased, rect, color
//   AddTextureRect            tex, tile, transpose, rect, modulate
//   AddTextureRectRegion      tex, transpose, clip_uv, rect, src, modulate
//   AddMsdfTextureRectRegion  tex, msdf_outline, rect, src, modulate, msdf_px_range, msdf_scale
//   AddLine                   antialiased, line_from, line_to, color, width
//   AddPolyline               antialiased, width, points, colors (hold-last)
//   AddMultiline              antialiased, width, points, colors (hold-last)
//   AddCircle                 antialiased, circle_position, circle_radius, color
//   AddPrimitive              has_tex/tex, points, colors, uvs
//   AddPolygon                has_tex/tex, points, colors, uvs
//   AddTriangleArray          has_tex/tex, points, colors, uvs, indices, triangle_count
//   AddNinePatch              has_tex/tex, rect, src (source), np_margin_tl, np_margin_br,
//                             x_axis, y_axis, draw_center, modulate
//   AddMesh                   mesh, has_tex/tex, transform, modulate
//   AddSetTransform           transform
//   AddClipIgnore             clip_ignore
//   Unsupported               name, reason
struct Command {
  CommandKind kind = CommandKind::AddRect;
  bool antialiased = false;
  bool has_tex = false;  // false -> "tex": null (the engine's RID())
  std::uint32_t tex = 0;
  bool tile = false;
  bool transpose = false;
  bool clip_uv = false;
  Rect4 rect = kZeroRect;
  Rect4 src = kZeroRect;
  Color4 color = kWhite;     // AddRect, AddLine, AddCircle
  Color4 modulate = kWhite;  // AddTextureRect* / AddMsdf / AddNinePatch / AddMesh
  std::string name;          // Unsupported: the hooked RenderingServer method name
  UnsupportedCmdReason unsupported_reason = UnsupportedCmdReason::UnsupportedOp;
  // new at /3 (AddMsdfTextureRectRegion only): the engine's int outline_size, px_range and
  // size/msdf_size scale (render-stream-3.md "Command"; gate4-design.md Q1g).
  std::int32_t msdf_outline = 0;
  float msdf_px_range = 0.0f;
  float msdf_scale = 0.0f;

  // --- new at /4 (render-stream-4.md "Command") ------------------------------------------------
  Point2 line_from = kZeroPoint2;   // AddLine
  Point2 line_to = kZeroPoint2;     // AddLine
  float width = 0.0f;               // AddLine, AddPolyline, AddMultiline
  std::vector<Point2> points;       // AddPolyline/AddMultiline/AddPrimitive/AddPolygon/AddTriangleArray
  std::vector<Color4> colors;       // same ops: 0, 1 or n entries (hold-last for poly/multiline)
  std::vector<Point2> uvs;          // AddPrimitive/AddPolygon/AddTriangleArray: 0 or n entries
  std::vector<std::int32_t> indices;  // AddTriangleArray
  std::int32_t triangle_count = -1;   // AddTriangleArray "count" (-1 = all indices)
  Point2 circle_position = kZeroPoint2;  // AddCircle
  float circle_radius = 0.0f;            // AddCircle
  Point2 np_margin_tl = kZeroPoint2;      // AddNinePatch: margin top-left
  Point2 np_margin_br = kZeroPoint2;      // AddNinePatch: margin bottom-right
  AxisStretchMode x_axis = AxisStretchMode::Stretch;  // AddNinePatch
  AxisStretchMode y_axis = AxisStretchMode::Stretch;  // AddNinePatch
  bool draw_center = true;                // AddNinePatch
  std::uint32_t mesh = 0;                 // AddMesh: the wire mesh id (always present for this kind)
  Xform transform = kIdentityXform;       // AddMesh, AddSetTransform
  bool clip_ignore = false;               // AddClipIgnore
};

// The mirror's full state for one item at one frame: always carries its complete `commands`.
// Never encoded directly -- see ItemEntry for the wire-level, possibly-null-commands form.
struct ItemState {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;
  ParentRef parent;
  std::vector<std::uint32_t> children;
  Xform xform = kIdentityXform;
  Color4 modulate = kWhite;
  Color4 self_modulate = kWhite;
  bool visible = true;
  std::int32_t draw_index = 0;
  std::int32_t z_index = 0;
  bool z_relative = true;
  bool behind = false;
  bool clip = false;
  bool custom_rect = false;
  Rect4 custom_rect_rect = kZeroRect;
  std::uint32_t visibility_layer = 0xFFFFFFFFu;
  Filter texture_filter = Filter::Default;   // new at /2
  Repeat texture_repeat = Repeat::Default;   // new at /2
  std::uint64_t content_version = 0;
  std::vector<Command> commands;
};

struct CanvasState {
  std::uint32_t id = 0;
  Origin origin = Origin::Created;
  CanvasRole role = CanvasRole::None;
  bool attached = false;
  Xform xform = kIdentityXform;
  std::vector<std::uint32_t> items;
};

// A canvas texture's own state (render-stream-2.md "Texture", G2d); null ("has_canvas = false")
// for `image` and `placeholder` kinds.
struct CanvasTextureInfo {
  bool has_diffuse = false;
  std::uint32_t diffuse = 0;
  Filter filter = Filter::Default;
  Repeat repeat = Repeat::Default;
};

// One texture-table entry (render-stream-2.md "Texture"). Field meaning by kind/status is the
// field table there; this struct can represent any legal combination, and an illegal one too
// (for building invalid golden vectors), since it performs no validation itself.
struct TextureEntry {
  std::uint32_t id = 0;
  TextureKind kind = TextureKind::Image;
  TextureStatus status = TextureStatus::Ok;
  bool has_reason = false;
  TextureReason reason = TextureReason::UnsupportedFormat;
  std::uint64_t version = 1;
  bool has_hash = false;  // false -> "hash": null
  std::string hash;       // 64 lowercase hex
  bool has_format = false;  // false -> "format": null
  std::string format;
  std::int32_t width = 0;
  std::int32_t height = 0;
  bool mipmaps = false;
  std::uint64_t payload_bytes = 0;
  bool has_canvas = false;  // false -> "canvas": null
  CanvasTextureInfo canvas;
};

// --- new at /4: the mesh table (render-stream-4.md "Mesh table") ------------------------------

// One surface of an "ok" mesh entry: the render-stream-mesh/1 payload's hash and whole-payload
// byte length, plus the shape fields a receiver needs before fetching that payload.
struct MeshSurface {
  std::string hash;  // 64 lowercase hex, the sha256 of the whole GRM1 payload
  std::uint64_t payload_bytes = 0;
  Primitive primitive = Primitive::Triangles;
  // The engine's raw ARRAY_FORMAT_* bitmask (gate5-design.md Q1e); format version bit 35 means
  // this can exceed 32 bits, so it is a signed 64-bit value, never interpreted by this codec.
  std::int64_t format = 0;
  std::int32_t vertex_count = 0;
  std::int32_t index_count = 0;
};

// One mesh-table entry (render-stream-4.md "Mesh table"). `has_aabb` is false exactly for
// `status == Freed` ("f": null); `custom_aabb` is six floats (position xyz, size xyz), all zero
// meaning "no custom AABB set".
struct MeshEntry {
  std::uint32_t id = 0;
  MeshStatus status = MeshStatus::Ok;
  bool has_reason = false;
  MeshReason reason = MeshReason::MeshFormat;
  std::uint64_t version = 1;
  bool has_aabb = true;
  std::array<float, 6> custom_aabb = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
  std::vector<MeshSurface> surfaces;
};

struct Failure {
  FailureReason reason = FailureReason::RootQueryFailed;
  std::string detail;
};

struct UnsupportedRef {
  std::string op;
  bool has_item = false;
  std::uint32_t item = 0;
  UnsupportedReason reason = UnsupportedReason::UnsupportedOp;
};

// The mirror's complete captured state for one frame.
struct Snapshot {
  // Which wire format make_full()/make_patch() (rs2_diff.cpp) produce from this Snapshot, exactly
  // mirroring Transaction::version's reasoning: V2 and V3 are byte-identical here, so this only
  // ever needs to distinguish V4 (meshes) from everything before it. Defaults to V2.
  ProtocolVersion version = ProtocolVersion::V2;
  std::uint64_t seq = 0;
  std::uint64_t frame = 0;
  std::vector<Failure> failures;
  std::vector<UnsupportedRef> unsupported;
  Filter default_texture_filter = Filter::Nearest;    // new at /2: never Default on the wire
  Repeat default_texture_repeat = Repeat::Disabled;   // new at /2: never Default on the wire
  std::vector<CanvasState> canvases;  // sorted by id ascending
  std::vector<ItemState> items;       // sorted by id ascending
  std::vector<TextureEntry> textures; // sorted by id ascending; new at /2
  std::vector<MeshEntry> meshes;      // sorted by id ascending; new at /4

  TransactionStatus status() const {
    return failures.empty() ? TransactionStatus::Ok : TransactionStatus::CaptureFailure;
  }
};

// ----------------------------------------------------------------------------------- transaction (wire-level)

struct ItemEntry {
  ItemState state;
  bool commands_null = false;
};

// The wire-level transaction record: either a full copy of a Snapshot or a patch against a base
// Snapshot. `failures`/`unsupported`/`default_texture_filter`/`default_texture_repeat` are always
// complete, never patched (render-stream-2.md "Transaction record": "Both are present in full and
// in patch transactions").
struct Transaction {
  // Which wire format encode_transaction() produces (render-stream-4.md): V2 and V3 transactions
  // are byte-identical in shape (/3 added only a command kind and a sabotage kind, never touching
  // the transaction's own keys or blocks), so this only ever needs to distinguish V4 (the mesh
  // table, removed_meshes, cmd_i32, mesh_f32) from everything before it. Defaults to V2, so every
  // existing /2 and /3 caller that never sets this field is unaffected.
  ProtocolVersion version = ProtocolVersion::V2;
  std::uint64_t seq = 0;
  std::uint64_t frame = 0;
  Encoding encoding = Encoding::Full;
  std::optional<std::uint64_t> base_seq;
  std::vector<Failure> failures;
  std::vector<UnsupportedRef> unsupported;
  Filter default_texture_filter = Filter::Nearest;
  Repeat default_texture_repeat = Repeat::Disabled;
  std::vector<std::uint32_t> removed_canvases;  // ascending
  std::vector<std::uint32_t> removed_items;     // ascending
  std::vector<std::uint32_t> removed_textures;  // ascending; new at /2
  std::vector<std::uint32_t> removed_meshes;    // ascending; new at /4
  std::vector<CanvasState> canvases;             // ascending by id; full entries
  std::vector<ItemEntry> items;                  // ascending by id
  std::vector<TextureEntry> textures;            // ascending by id; new at /2; full entries
  std::vector<MeshEntry> meshes;                 // ascending by id; new at /4; full entries

  TransactionStatus status() const {
    return failures.empty() ? TransactionStatus::Ok : TransactionStatus::CaptureFailure;
  }
};

// ----------------------------------------------------------------------------------- resource record

// A standalone "resource" record (render-stream-2.md "Resource record"): `payload` is a complete
// render-stream-texture/1 byte sequence (built and hashed elsewhere -- rs_texture_payload, G2a).
// This codec only packages already-computed bytes; it performs no hashing of its own.
struct ResourceRecord {
  std::string hash;  // 64 lowercase hex, the sha256 of `payload`
  std::vector<std::uint8_t> payload;
};

// ----------------------------------------------------------------------------------- end

struct EndStats {
  std::uint64_t bytes_total = 0;
  std::uint64_t encode_ns_total = 0;
  std::uint64_t snapshot_ns_total = 0;
  std::uint64_t diff_ns_total = 0;
  std::uint64_t max_record_bytes = 0;
  std::uint64_t full_transactions = 0;
  std::uint64_t patch_transactions = 0;
  std::uint64_t resource_records = 0;  // new at /2
  std::uint64_t resource_bytes = 0;    // new at /2
};

struct End {
  std::uint64_t transactions = 0;
  EndReason reason = EndReason::Shutdown;
  EndStats stats;
};

}  // namespace rs2
}  // namespace grc

#endif  // GRC_RS2_SNAPSHOT_H
